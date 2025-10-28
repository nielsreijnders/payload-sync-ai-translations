import type { LocaleTranslationSelection, PendingReview } from '../types'

/**
 * prepareLocalesForTranslation
 * ------------------------------------
 * Converts raw per-locale review state (overrides, skipped, chosen indexes)
 * into a normalized selection object for the translation run.
 *
 * - Sanitizes indexes (bounds check, integer check)
 * - Applies override text trimming and ignores empty overrides
 * - Excludes skipped or overridden indexes from the auto-translate list
 */
export function prepareLocalesForTranslation(
  items: PendingReview['items'],
  locales: PendingReview['locales'],
): LocaleTranslationSelection[] {
  return locales
    .map((locale) => {
      const skipSet = new Set(locale.skipped)

      const overrideEntries = Object.entries(locale.overrides)
        .map(([key, value]) => {
          const parsedIndex = Number(key)
          if (!Number.isInteger(parsedIndex)) {
            return null
          }

          const item = items[parsedIndex]
          if (!item) {
            return null
          }

          const text = value.trim()
          if (!text) {
            return null
          }

          return { index: parsedIndex, item: { ...item, text } }
        })
        .filter((entry): entry is { index: number; item: PendingReview['items'][number] } =>
          Boolean(entry),
        )

      const overrideIndexes = new Set(overrideEntries.map((entry) => entry.index))

      const translateIndexes = Array.from(new Set(locale.translateIndexes))
        .filter((index) => Number.isInteger(index) && index >= 0 && index < items.length)
        .filter((index) => !skipSet.has(index) && !overrideIndexes.has(index))

      return {
        code: locale.code,
        overrides: overrideEntries.map((e) => e.item),
        translateIndexes,
      }
    })
    .filter((l) => l.translateIndexes.length || l.overrides.length)
}
