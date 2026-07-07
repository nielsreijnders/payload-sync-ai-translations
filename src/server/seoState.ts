import type { CollectionConfig, LocalizationConfig } from 'payload'

import type { AiSeoCollectionOptions } from '../plugin.js'

export type StoredSeoCollection = {
  contentFields?: string[]
  descriptionPath: string
  label: string
  labelPath: string
  slug: string
  slugPath: string
  titlePath: string
}

type SeoState = {
  collections: Record<string, StoredSeoCollection>
  defaultLocale: string
  locales: string[]
}

let seoState: SeoState = {
  collections: {},
  defaultLocale: '',
  locales: [],
}

function resolveLocaleCodes(locales: LocalizationConfig['locales']): string[] {
  return (locales ?? [])
    .map((locale) => (typeof locale === 'string' ? locale : locale.code))
    .filter((value): value is string => Boolean(value))
}

function humanizeSlug(slug: string): string {
  return slug
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function normalizeOptions(
  collection: CollectionConfig,
  options: AiSeoCollectionOptions | boolean,
): StoredSeoCollection {
  const normalized: AiSeoCollectionOptions = typeof options === 'object' ? options : {}
  const configuredLabelPath =
    typeof collection.admin?.useAsTitle === 'string' ? collection.admin.useAsTitle : undefined
  const label =
    collection.labels?.plural || collection.labels?.singular || humanizeSlug(collection.slug)

  return {
    slug: collection.slug,
    contentFields: normalized.contentFields?.map((path) => path.trim()).filter(Boolean),
    descriptionPath: normalized.descriptionPath?.trim() || 'meta.description',
    label: typeof label === 'string' ? label : collection.slug,
    labelPath: normalized.labelPath?.trim() || configuredLabelPath || 'title',
    slugPath: normalized.slugPath?.trim() || 'slug',
    titlePath: normalized.titlePath?.trim() || 'meta.title',
  }
}

export function configureSeoState(
  collections: Array<{
    config: CollectionConfig
    options: AiSeoCollectionOptions | boolean
  }>,
  localization: {
    defaultLocale?: LocalizationConfig['defaultLocale']
    locales?: LocalizationConfig['locales']
  },
): void {
  const storedCollections: Record<string, StoredSeoCollection> = {}

  for (const entry of collections) {
    if (!entry.config?.slug) {
      continue
    }

    storedCollections[entry.config.slug] = normalizeOptions(entry.config, entry.options)
  }

  seoState = {
    collections: storedCollections,
    defaultLocale: localization.defaultLocale || '',
    locales: resolveLocaleCodes(localization.locales ?? []),
  }
}

export function getSeoCollection(slug: string): null | StoredSeoCollection {
  return seoState.collections[slug] ?? null
}

export function getSeoState(): SeoState {
  return seoState
}

export function listSeoCollections(): StoredSeoCollection[] {
  return Object.values(seoState.collections)
}
