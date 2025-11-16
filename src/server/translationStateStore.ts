import type { CollectionConfig, LocalizationConfig } from 'payload'

import { type AnyField, collectLocalizedFieldPatterns } from '../utils/localizedFields.js'

export type StoredCollection = {
  fieldPatterns: string[]
  type: 'collection' | 'global'
  label: string
  slug: string
  customPrompt?: (data: unknown, locale: string) => string | undefined
}

export type TranslationState = {
  collections: Record<string, StoredCollection>
  globals: Record<string, StoredCollection>
  defaultLocale: string
  locales: string[]
}

let translationState: TranslationState = {
  collections: {},
  globals: {},
  defaultLocale: '',
  locales: [],
}

function normalizeRoot(path: string): string {
  const [first] = path.split('.')
  if (!first) {
    return ''
  }

  return first.replace(/\[\]$/, '')
}

function filterPatterns(patterns: string[], exclude: string[] = []): string[] {
  if (!exclude.length) {
    return patterns
  }

  const excluded = new Set(exclude.map((value) => value.trim()).filter(Boolean))
  if (!excluded.size) {
    return patterns
  }

  return patterns.filter((pattern) => !excluded.has(normalizeRoot(pattern)))
}

function extractFieldPatterns(collection: CollectionConfig, exclude?: string[]): string[] {
  const fields = (collection.fields ?? []) as AnyField[]
  const allPatterns = collectLocalizedFieldPatterns(fields)
  return filterPatterns(allPatterns, exclude)
}

function resolveLocaleCodes(locales: LocalizationConfig['locales']): string[] {
  return (locales ?? [])
    .map((locale) => (typeof locale === 'string' ? locale : locale.code))
    .filter((value): value is string => Boolean(value))
}

export function configureTranslationState(
  collections: Array<{
    config: CollectionConfig
    customPrompt?: StoredCollection['customPrompt']
    excludeFields?: string[]
  }>,
  globalsOrLocalization:
    | Array<{
        config: GlobalConfig
        customPrompt?: StoredCollection['customPrompt']
        excludeFields?: string[]
      }>
    | {
        defaultLocale?: LocalizationConfig['defaultLocale']
        locales?: LocalizationConfig['locales']
      },
  maybeLocalization?: {
    defaultLocale?: LocalizationConfig['defaultLocale']
    locales?: LocalizationConfig['locales']
  },
): void {
  const globalsList = Array.isArray(globalsOrLocalization) ? globalsOrLocalization : []
  const localization = Array.isArray(globalsOrLocalization)
    ? maybeLocalization
    : maybeLocalization ?? globalsOrLocalization

  if (!localization) {
    throw new Error('Missing localization settings for translation state.')
  }

  const collectionEntries: Record<string, StoredCollection> = {}
  const globalEntries: Record<string, StoredCollection> = {}

  for (const entry of collections) {
    const { config, excludeFields, customPrompt } = entry
    if (!config?.slug) {
      continue
    }

    const slug = config.slug
    const label = config.labels?.plural || config.labels?.singular || slug || ''
    const fieldPatterns = extractFieldPatterns(config, excludeFields)

    collectionEntries[slug] = {
      slug,
      fieldPatterns,
      // @ts-expect-error - i need to look into this
      label,
      type: 'collection',
      customPrompt,
    }
  }

  for (const entry of globalsList) {
    const { config, excludeFields, customPrompt } = entry
    if (!config?.slug) {
      continue
    }

    const slug = config.slug
    const label = config.label || slug || ''
    const fieldPatterns = extractFieldPatterns(config as unknown as CollectionConfig, excludeFields)

    globalEntries[slug] = {
      slug,
      fieldPatterns,
      // @ts-expect-error - i need to look into this
      label,
      type: 'global',
      customPrompt,
    }
  }

  translationState = {
    collections: collectionEntries,
    globals: globalEntries,
    defaultLocale: localization.defaultLocale || '',
    locales: resolveLocaleCodes(localization.locales || []),
  }
}

export function getTranslationState(): TranslationState {
  return translationState
}

export function getStoredCollection(slug: string): null | StoredCollection {
  return translationState.collections[slug] ?? translationState.globals[slug] ?? null
}

export function listStoredCollections(): StoredCollection[] {
  return Object.values(translationState.collections)
}

export function listStoredGlobals(): StoredCollection[] {
  return Object.values(translationState.globals)
}
