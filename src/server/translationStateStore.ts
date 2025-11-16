import type { CollectionConfig, GlobalConfig, LocalizationConfig } from 'payload'

import { type AnyField, collectLocalizedFieldPatterns } from '../utils/localizedFields.js'

export type StoredEntry = {
  customPrompt?: (data: unknown, locale: string) => string | undefined
  fieldPatterns: string[]
  label: string
  slug: string
}

export type TranslationState = {
  collections: Record<string, StoredEntry>
  defaultLocale: string
  globals: Record<string, StoredEntry>
  locales: string[]
}

let translationState: TranslationState = {
  collections: {},
  defaultLocale: '',
  globals: {},
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

function extractFieldPatterns(config: { fields?: AnyField[] }, exclude?: string[]): string[] {
  const fields = config.fields ?? []
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
    customPrompt?: StoredEntry['customPrompt']
    excludeFields?: string[]
  }>,
  globals: Array<{
    config: GlobalConfig
    customPrompt?: StoredEntry['customPrompt']
    excludeFields?: string[]
  }> = [],
  localization: {
    defaultLocale?: LocalizationConfig['defaultLocale']
    locales?: LocalizationConfig['locales']
  } = {},
): void {
  const storedCollections: Record<string, StoredEntry> = {}
  const storedGlobals: Record<string, StoredEntry> = {}

  for (const entry of collections) {
    const { config, customPrompt, excludeFields } = entry
    if (!config?.slug) {
      continue
    }

    const slug = config.slug
    const label = config.labels?.plural || config.labels?.singular || slug || ''
    const fieldPatterns = extractFieldPatterns(config, excludeFields)

    storedCollections[slug] = {
      slug,
      customPrompt,
      fieldPatterns,
      // @ts-expect-error -- Need to investigate
      label,
    }
  }

  const normalizedGlobals = Array.isArray(globals) ? globals : []

  for (const entry of normalizedGlobals) {
    const { config, customPrompt, excludeFields } = entry
    if (!config?.slug) {
      continue
    }

    const slug = config.slug
    const label = config.label || slug || ''
    const fieldPatterns = extractFieldPatterns(config, excludeFields)

    storedGlobals[slug] = {
      slug,
      customPrompt,
      fieldPatterns,
      // @ts-expect-error -- Need to investigate
      label,
    }
  }

  translationState = {
    collections: storedCollections,
    defaultLocale: localization?.defaultLocale || '',
    globals: storedGlobals,
    locales: resolveLocaleCodes(localization?.locales || []),
  }
}

export function getTranslationState(): TranslationState {
  return translationState
}

export function getStoredCollection(slug: string): null | StoredEntry {
  return translationState.collections[slug] ?? null
}

export function getStoredGlobal(slug: string): null | StoredEntry {
  return translationState.globals[slug] ?? null
}

export function getStoredTarget(target: {
  collection?: string
  global?: string
}): null | StoredEntry {
  if (target.collection) {
    return getStoredCollection(target.collection)
  }

  if (target.global) {
    return getStoredGlobal(target.global)
  }

  return null
}

export function listStoredCollections(): StoredEntry[] {
  return Object.values(translationState.collections)
}

export function listStoredGlobals(): StoredEntry[] {
  return Object.values(translationState.globals)
}
