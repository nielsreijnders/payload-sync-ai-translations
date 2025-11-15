import type { Payload } from 'payload'

import { logDebug } from './debugSettings.js'
import type { StoredCollection } from './translationStateStore.js'

export type CustomPromptFunction = StoredCollection['customPrompt']

export function resolveCustomPrompt(
  payload: Payload,
  customPrompt: CustomPromptFunction,
  data: unknown,
  context: { collection: string; documentId: string | number; locale: string },
): string | undefined {
  if (typeof customPrompt !== 'function') {
    return undefined
  }

  try {
    const result = customPrompt(data, context.locale)
    if (typeof result !== 'string') {
      return undefined
    }

    const trimmed = result.trim()
    if (!trimmed) {
      return undefined
    }

    logDebug(payload, '[AI Translate] Custom prompt generated for locale.', {
      collection: context.collection,
      documentId: context.documentId,
      locale: context.locale,
      prompt: trimmed,
    })

    return trimmed
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    payload.logger?.error?.(
      `[AI Translate] Custom prompt failed for ${context.collection}#${context.documentId} (${context.locale}): ${message}`,
    )
    logDebug(payload, '[AI Translate] Custom prompt execution failed.', {
      collection: context.collection,
      documentId: context.documentId,
      error: message,
      locale: context.locale,
    })
    return undefined
  }
}
