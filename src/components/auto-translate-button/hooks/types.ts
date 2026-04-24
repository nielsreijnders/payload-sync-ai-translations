import type { LocalizationConfig, TypedLocale } from 'payload'

import type { TranslateReviewLocale } from '../../../server/translationTypes.js'
import type { AnyField } from '../../../utils/localizedFields.js'
import type {
  buildTranslatableItems,
  collectIdentifierPaths,
} from '../utils/buildTranslatableItems.js'

export type AutoTranslateButtonProps = {
  defaultLocale: TypedLocale
  fieldPatterns?: string[]
  locales: LocalizationConfig['locales']
}

export type FormApi = {
  getData?: () => unknown
}

export type TranslatableItem = ReturnType<typeof buildTranslatableItems>[number]

export type PendingReviewLocale = {
  /**
   * Map of item index -> reviewer-provided override text
   */
  overrides: Record<number, string>
  /**
   * List of item indexes the reviewer chose to skip
   */
  skipped: number[]
} & TranslateReviewLocale

export type PendingReview = {
  /**
   * Flat list of all translatable items detected in the document
   */
  items: ReturnType<typeof buildTranslatableItems>
  /**
   * Identifier paths that should be preserved for each locale
   */
  identifierPaths: ReturnType<typeof collectIdentifierPaths>
  /**
   * Per-locale review state (overrides, skips, selection)
   */
  locales: PendingReviewLocale[]
}

export type LocaleTranslationSelection = {
  /**
   * Locale code (e.g. "de", "fr-FR")
   */
  code: string
  /**
   * Identifier paths that must be included in the translation payload
   */
  identifierPaths: PendingReview['identifierPaths']
  /**
   * Items with reviewer overrides to apply immediately
   */
  overrides: PendingReview['items'][number][]
  /**
   * Indexes of items that should be auto-translated by the engine
   */
  translateIndexes: number[]
}

export type LocalizedFieldPatternsInput = { fields?: AnyField[] } | undefined
