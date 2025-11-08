import type { Payload } from 'payload'

import { cloneLocaleData } from './localeStructure.js'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stripDocumentMetadata(value: unknown): void {
  if (!isPlainObject(value)) {
    return
  }

  delete value.id
  delete value._id
  delete value.createdAt
  delete value.updatedAt
}

type LoadDocumentOptions = {
  collection: string
  fallbackLocale?: boolean
  id: number | string
  locale: string
}

export async function loadLocalizedDocument(
  payload: Payload,
  options: LoadDocumentOptions,
): Promise<null | Record<string, unknown>> {
  const { id, collection, fallbackLocale = false, locale } = options

  try {
    const doc = await payload.findByID({
      id,
      collection,
      depth: 0,
      // @ts-expect-error temp
      fallbackLocale,
      locale,
    })

    if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
      const clone = cloneLocaleData(doc)
      stripDocumentMetadata(clone)
      return clone as Record<string, unknown>
    }
  } catch (error) {
    payload.logger?.debug?.(
      `[AI Links] Failed to load ${collection}#${id} (${locale}): ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    )
  }

  return null
}
