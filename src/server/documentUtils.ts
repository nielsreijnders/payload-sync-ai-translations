import type { Payload } from 'payload'

import { cloneLocaleData } from './localeStructure.js'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const DOCUMENT_METADATA_KEYS = new Set(['id', '_id', 'createdAt', 'updatedAt'])

function deleteDocumentMetadata(record: Record<string, unknown>): void {
  for (const key of DOCUMENT_METADATA_KEYS) {
    delete record[key]
  }
}

function cloneWithoutMetadata(value: unknown, deep: boolean): unknown {
  if (Array.isArray(value)) {
    return deep ? value.map((entry) => cloneWithoutMetadata(entry, true)) : value
  }

  if (!isPlainObject(value)) {
    return value
  }

  const cloned: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (DOCUMENT_METADATA_KEYS.has(key)) {
      continue
    }

    cloned[key] = deep ? cloneWithoutMetadata(child, true) : child
  }

  return cloned
}

export function stripDocumentMetadata(value: unknown): void {
  if (!isPlainObject(value)) {
    return
  }

  deleteDocumentMetadata(value)
}

export function cloneWithoutDocumentMetadata<T>(value: T): T {
  if (!isPlainObject(value)) {
    return value
  }

  return cloneWithoutMetadata(value, false) as T
}

export function cloneWithoutDocumentMetadataDeep<T>(value: T): T {
  return cloneWithoutMetadata(value, true) as T
}

type LoadDocumentOptions =
  | {
      collection: string
      fallbackLocale?: boolean
      id: number | string
      locale: string
    }
  | {
      fallbackLocale?: boolean
      global: string
      locale: string
    }

export async function loadLocalizedDocument(
  payload: Payload,
  options: LoadDocumentOptions,
): Promise<null | Record<string, unknown>> {
  const { fallbackLocale = false, locale } = options

  try {
    const doc =
      'collection' in options
        ? await payload.findByID({
            id: options.id,
            collection: options.collection,
            depth: 0,
            // @ts-expect-error temp
            fallbackLocale,
            locale,
          })
        : await payload.findGlobal({
            slug: options.global,
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
    const targetLabel =
      'collection' in options ? `${options.collection}#${options.id}` : `global:${options.global}`
    payload.logger?.debug?.(
      `[AI Links] Failed to load ${targetLabel} (${locale}): ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    )
  }

  return null
}
