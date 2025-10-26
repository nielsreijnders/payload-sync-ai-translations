import type { CollectionConfig, LocalizationConfig } from 'payload'

import { type AnyField, collectLocalizedFieldPatterns } from '../utils/localizedFields.js'

export type StoredCollection = {
  fieldPatterns: string[]
  label: string
  slug: string
}

export type TranslationState = {
  collections: Record<string, StoredCollection>
  defaultLocale: string
  locales: string[]
}

let translationState: TranslationState = {
  collections: {},
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
  collections: Array<{ config: CollectionConfig; excludeFields?: string[] }>,
  localization: { defaultLocale?: LocalizationConfig['defaultLocale']; locales?: LocalizationConfig['locales'] },
): void {
  const entries: Record<string, StoredCollection> = {}

  for (const entry of collections) {
    const { config, excludeFields } = entry
    if (!config?.slug) {
      continue
    }

    const slug = config.slug
    const label = config.labels?.plural || config.labels?.singular || slug
    const fieldPatterns = extractFieldPatterns(config, excludeFields)

    entries[slug] = {
      slug,
      fieldPatterns,
      label,
    }
  }

  translationState = {
    collections: entries,
    defaultLocale: localization.defaultLocale || '',
    locales: resolveLocaleCodes(localization.locales || []),
  }
}

export function getTranslationState(): TranslationState {
  return translationState
}

export function getStoredCollection(slug: string): null | StoredCollection {
  return translationState.collections[slug] ?? null
}

export function listStoredCollections(): StoredCollection[] {
  return Object.values(translationState.collections)
}
