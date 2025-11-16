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

export function cloneWithoutDocumentMetadata<T>(value: T): T {
  if (!isPlainObject(value)) {
    return value
  }

  const { id: _id, _id: __id, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = value
  return rest as T
}

type LoadDocumentOptions =
  | {
      collection: string
      fallbackLocale?: boolean
      id: number | string
      locale: string
    }
  | {
      global: string
      fallbackLocale?: boolean
      locale: string
    }

export async function loadLocalizedDocument(
  payload: Payload,
  options: LoadDocumentOptions,
): Promise<null | Record<string, unknown>> {
  const { fallbackLocale = false, locale } = options

  try {
    const doc = 'collection' in options
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
      'collection' in options
        ? `${options.collection}#${options.id}`
        : `global:${options.global}`
    payload.logger?.debug?.(
      `[AI Links] Failed to load ${targetLabel} (${locale}): ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    )
  }

  return null
}
