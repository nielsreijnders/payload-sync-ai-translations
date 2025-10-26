import type { TranslatableItem } from '../components/auto-translate-button/utils/buildTranslatableItems.js'
import type { TranslationRequest } from '../components/auto-translate-button/utils/performTranslations.js'
import type { TranslateReviewLocale } from '../server/types.js'

import { chunkItems } from './localizedFields.js'

export type LocalePreparationInput = {
  code: string
  overrides?: Record<number, string>
  skipped?: Iterable<number>
  translateIndexes: number[]
}

export type LocaleTranslationSelection = {
  code: string
  overrides: TranslatableItem[]
  translateIndexes: number[]
}

export function createLocaleSelection(
  items: TranslatableItem[],
  locale: LocalePreparationInput,
): LocaleTranslationSelection {
  const skipSet = new Set(locale.skipped ?? [])

  const overrideEntries = Object.entries(locale.overrides ?? {})
    .map(([rawIndex, value]) => {
      const index = Number(rawIndex)
      if (!Number.isInteger(index)) {
        return null
      }

      const item = items[index]
      if (!item) {
        return null
      }

      const text = typeof value === 'string' ? value.trim() : ''
      if (!text) {
        return null
      }

      return { index, item: { ...item, text } }
    })
    .filter((entry): entry is { index: number; item: TranslatableItem } => Boolean(entry))

  const overrideIndexes = new Set(overrideEntries.map((entry) => entry.index))

  const translateIndexes = Array.from(new Set(locale.translateIndexes))
    .filter((index) => Number.isInteger(index) && index >= 0 && index < items.length)
    .filter((index) => !skipSet.has(index) && !overrideIndexes.has(index))

  return {
    code: locale.code,
    overrides: overrideEntries.map((entry) => entry.item),
    translateIndexes,
  }
}

export function prepareLocalesForTranslation(
  items: TranslatableItem[],
  locales: LocalePreparationInput[],
): LocaleTranslationSelection[] {
  return locales
    .map((locale) => createLocaleSelection(items, locale))
    .filter((locale) => locale.translateIndexes.length || locale.overrides.length)
}

export type BuildTranslationRequestArgs = {
  collection: string
  defaultLocale: string
  documentID: string
  items: TranslatableItem[]
  locales: LocaleTranslationSelection[]
}

export function buildTranslationRequest(
  args: BuildTranslationRequestArgs,
): null | TranslationRequest {
  const { collection, defaultLocale, documentID, items, locales } = args

  const localesWithChunks = locales
    .map((locale) => {
      const selectedItems = locale.translateIndexes
        .filter((index) => Number.isInteger(index) && index >= 0 && index < items.length)
        .map((index) => items[index])

      return {
        chunks: chunkItems(selectedItems),
        code: locale.code,
        overrides: locale.overrides,
      }
    })
    .filter((locale) => locale.chunks.length || (locale.overrides?.length ?? 0) > 0)

  if (!localesWithChunks.length) {
    return null
  }

  return {
    id: documentID,
    collection,
    defaultLocale,
    locales: localesWithChunks,
  }
}

export function localeRequiresManualReview(locale: TranslateReviewLocale): boolean {
  return (locale.mismatches?.length ?? 0) > 0 && locale.existingCount > 0
}
