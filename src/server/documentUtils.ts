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
  id: string | number
  locale: string
  fallbackLocale?: boolean
}

export async function loadLocalizedDocument(
  payload: Payload,
  options: LoadDocumentOptions,
): Promise<Record<string, unknown> | null> {
  const { collection, id, locale, fallbackLocale = false } = options

  try {
    const doc = await payload.findByID({
      collection,
      depth: 0,
      fallbackLocale,
      id,
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
