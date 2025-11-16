import type { LocaleTranslationSelection, PendingReview } from '../hooks/types.js'

import { chunkItems } from '../../../utils/localizedFields.js'

/**
 * buildTranslationRequest
 * ------------------------------------
 * Shapes a safe, chunked server request payload for translations.
 * - Validates presence of collection/doc ID
 * - Filters and chunks indexes per locale
 */
export function buildTranslationRequest(
  items: PendingReview['items'],
  locales: LocaleTranslationSelection[],
  opts: {
    collectionSlug?: string
    globalSlug?: string
    defaultLocale: string
    id?: number | string
  },
) {
  const { id, collectionSlug, defaultLocale, globalSlug } = opts

  if (!collectionSlug && !globalSlug) {
    throw new Error('Localization settings are missing.')
  }

  if (collectionSlug) {
    if (typeof id !== 'string' && typeof id !== 'number') {
      throw new Error('Document ID is missing.')
    }

    if (typeof id === 'string' && id.trim().length === 0) {
      throw new Error('Document ID is missing.')
    }
  }

  const identifier = typeof id === 'string' ? id.trim() : id

  const localesWithChunks = locales
    .map((locale) => {
      const selected = locale.translateIndexes
        .filter((index) => Number.isInteger(index) && index >= 0 && index < items.length)
        .map((index) => items[index])

      return {
        chunks: chunkItems(selected),
        code: locale.code,
        overrides: locale.overrides,
      }
    })
    .filter((locale) => locale.chunks.length || (locale.overrides?.length ?? 0) > 0)

  return {
    ...(collectionSlug ? { id: identifier, collection: collectionSlug } : { global: globalSlug }),
    defaultLocale,
    locales: localesWithChunks,
  }
}
