import type { PendingReview, PendingReviewLocale } from '../types'

/**
 * sanitizeLocalesFromReviewResponse
 * ------------------------------------
 * Normalizes the server review response:
 * - Deduplicates and bounds-checks translateIndexes
 * - Converts suggestions -> overrides map { index -> text }
 * - Drops locales with no work (no indexes & no overrides)
 */
export function sanitizeLocalesFromReviewResponse(
  itemsLength: number,
  rawLocales: Array<
    | ({
        suggestions?: { index: number; text?: string }[]
      } & Omit<PendingReviewLocale, 'overrides' | 'skipped'>)
    | PendingReviewLocale
  >,
): PendingReview['locales'] {
  return rawLocales
    .map((locale: any) => {
      const sanitizedIndexes = Array.from(new Set(locale.translateIndexes)).filter(
        (index) => Number.isInteger(index) && index >= 0 && index < itemsLength,
      )

      const overrides: Record<number, string> = {}
      for (const suggestion of locale.suggestions ?? []) {
        if (!Number.isInteger(suggestion.index)) {
          continue
        }
        const value = typeof suggestion.text === 'string' ? suggestion.text : ''
        if (value.trim()) {
          overrides[suggestion.index] = value
        }
      }

      return {
        ...locale,
        overrides,
        skipped: [],
        translateIndexes: sanitizedIndexes,
      } as PendingReviewLocale
    })
    .filter((locale) => locale.translateIndexes.length || Object.keys(locale.overrides).length)
}

/**
 * requiresHumanReview
 * ------------------------------------
 * Determines whether any locale has mismatches alongside existing content,
 * indicating a manual confirmation step is needed before translating.
 */
export function requiresHumanReview(locales: PendingReview['locales']): boolean {
  return locales.some(
    (locale) => (locale.mismatches?.length ?? 0) > 0 && (locale.existingCount ?? 0) > 0,
  )
}
