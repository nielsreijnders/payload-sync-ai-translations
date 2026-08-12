import type { CollectionConfig, GlobalConfig, LocalizationConfig } from 'payload'

import {
  type AnyBlock,
  type AnyField,
  collectLocalizedContainerPatterns,
  collectLocalizedFieldPatterns,
} from '../utils/localizedFields.js'

export type StoredEntry = {
  customPrompt?: (data: unknown, locale: string) => string | undefined
  fieldPatterns: string[]
  grammarCheckPrompt?: (data: unknown, locale: string) => string | undefined
  label: string
  localizedContainerPatterns: string[]
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

export function extractFieldPatterns(
  config: { fields?: unknown[] },
  options: {
    availableBlocks?: AnyBlock[]
    exclude?: string[]
  } = {},
): string[] {
  const fields = (config.fields ?? []) as AnyField[]
  const allPatterns = collectLocalizedFieldPatterns(
    fields,
    '',
    false,
    options.availableBlocks ?? [],
  )
  return filterPatterns(allPatterns, options.exclude)
}

export function extractLocalizedContainerPatterns(
  config: { fields?: unknown[] },
  options: {
    availableBlocks?: AnyBlock[]
    exclude?: string[]
  } = {},
): string[] {
  const fields = (config.fields ?? []) as AnyField[]
  const allPatterns = collectLocalizedContainerPatterns(
    fields,
    '',
    false,
    options.availableBlocks ?? [],
  )
  return filterPatterns(allPatterns, options.exclude)
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
    grammarCheckPrompt?: StoredEntry['grammarCheckPrompt']
  }>,
  globals: Array<{
    config: GlobalConfig
    customPrompt?: StoredEntry['customPrompt']
    excludeFields?: string[]
    grammarCheckPrompt?: StoredEntry['grammarCheckPrompt']
  }> = [],
  localization: {
    defaultLocale?: LocalizationConfig['defaultLocale']
    locales?: LocalizationConfig['locales']
  } = {},
  options: {
    availableBlocks?: AnyBlock[]
  } = {},
): void {
  const storedCollections: Record<string, StoredEntry> = {}
  const storedGlobals: Record<string, StoredEntry> = {}

  for (const entry of collections) {
    const { config, customPrompt, excludeFields, grammarCheckPrompt } = entry
    if (!config?.slug) {
      continue
    }

    const slug = config.slug
    const label = config.labels?.plural || config.labels?.singular || slug || ''
    const fieldPatterns = extractFieldPatterns(config, {
      availableBlocks: options.availableBlocks,
      exclude: excludeFields,
    })
    const localizedContainerPatterns = extractLocalizedContainerPatterns(config, {
      availableBlocks: options.availableBlocks,
      exclude: excludeFields,
    })

    storedCollections[slug] = {
      slug,
      customPrompt,
      fieldPatterns,
      grammarCheckPrompt,
      // @ts-expect-error -- Need to investigate
      label,
      localizedContainerPatterns,
    }
  }

  const normalizedGlobals = Array.isArray(globals) ? globals : []

  for (const entry of normalizedGlobals) {
    const { config, customPrompt, excludeFields, grammarCheckPrompt } = entry
    if (!config?.slug) {
      continue
    }

    const slug = config.slug
    const label = config.label || slug || ''
    const fieldPatterns = extractFieldPatterns(config, {
      availableBlocks: options.availableBlocks,
      exclude: excludeFields,
    })
    const localizedContainerPatterns = extractLocalizedContainerPatterns(config, {
      availableBlocks: options.availableBlocks,
      exclude: excludeFields,
    })

    storedGlobals[slug] = {
      slug,
      customPrompt,
      fieldPatterns,
      grammarCheckPrompt,
      // @ts-expect-error -- Need to investigate
      label,
      localizedContainerPatterns,
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

/**
 * Unique top-level roots of a set of translatable field patterns
 * (e.g. `title`, `slug`, `components`). Used by the admin UI to offer
 * skip-field checkboxes per collection.
 */
export function fieldPatternRoots(patterns: string[]): string[] {
  const roots = new Set<string>()

  for (const pattern of patterns) {
    const root = normalizeRoot(pattern)
    if (root) {
      roots.add(root)
    }
  }

  return Array.from(roots).sort()
}
