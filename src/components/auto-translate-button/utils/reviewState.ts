import type { PendingReview } from '../types'

/**
 * applyLocaleOverride
 * ------------------------------------
 * Returns a new PendingReview where a specific locale's override
 * text is set/cleared for a given item index.
 */
export function applyLocaleOverride(
  state: null | PendingReview,
  code: string,
  index: number,
  value: string,
): null | PendingReview {
  if (!state) {
    return state
  }

  return {
    ...state,
    locales: state.locales.map((locale) => {
      if (locale.code !== code) {
        return locale
      }

      const overrides = { ...locale.overrides }
      if (!value.trim()) {
        delete overrides[index]
      } else {
        overrides[index] = value
      }

      return { ...locale, overrides }
    }),
  }
}

/**
 * applyLocaleSkip
 * ------------------------------------
 * Returns a new PendingReview where a specific locale's skip flag
 * is toggled for a given item index. When skipping, any override
 * for that index is also removed.
 */
export function applyLocaleSkip(
  state: null | PendingReview,
  code: string,
  index: number,
  skip: boolean,
): null | PendingReview {
  if (!state) {
    return state
  }

  return {
    ...state,
    locales: state.locales.map((locale) => {
      if (locale.code !== code) {
        return locale
      }

      const skipped = new Set(locale.skipped)
      const overrides = { ...locale.overrides }

      if (skip) {
        skipped.add(index)
        delete overrides[index]
      } else {
        skipped.delete(index)
      }

      return { ...locale, overrides, skipped: Array.from(skipped) }
    }),
  }
}
