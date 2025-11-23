import type { Payload } from 'payload'

import type { LinkSyncLocaleReport, LinkSyncResult } from './linkSyncTypes.js'

import {
  cloneWithoutDocumentMetadata,
  loadLocalizedDocument,
  stripDocumentMetadata,
} from './documentUtils.js'
import { fetchAlternateLinks, selectAlternateForLocale } from './linkAlternate.js'
import { applyLinkOccurrence, collectLinkOccurrences } from './linkCollector.js'
import { mergeStructuralData } from './localeStructure.js'

type CollectionLinkOptions = {
  collection: string
  id: number | string
}

type GlobalLinkOptions = {
  global: string
}

type LinkSyncOptions = {
  defaultLocale: string
  fieldPatterns: string[]
  payload: Payload
  serverURL?: string
  targetLocales: string[]
} & (CollectionLinkOptions | GlobalLinkOptions)

type FetchCache = Map<string, Map<string, string>>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pruneIdentifierFields(value: unknown, allowed: Set<string>, currentPath = ''): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      const nextPath = currentPath ? `${currentPath}.${index}` : String(index)
      return pruneIdentifierFields(entry, allowed, nextPath)
    })
  }

  if (isPlainObject(value)) {
    const record = value
    const next: Record<string, unknown> = {}

    for (const [key, child] of Object.entries(record)) {
      const childPath = currentPath ? `${currentPath}.${key}` : key
      const normalizedChildPath = childPath.replace(/\.\d+(?=\.|$)/g, '.[]')

      if ((key === 'id' || key === '_id') && !allowed.has(normalizedChildPath)) {
        continue
      }

      next[key] = pruneIdentifierFields(child, allowed, childPath)
    }

    return next
  }

  return value
}

function ensureArray<T>(value: Iterable<T> | undefined): T[] {
  return value ? Array.from(value) : []
}

export async function synchronizeLinksForDocument(
  options: LinkSyncOptions,
  cache: FetchCache = new Map(),
): Promise<LinkSyncResult> {
  const { defaultLocale, fieldPatterns, payload, serverURL, targetLocales } = options
  const isCollectionTarget = 'collection' in options
  const targetLabel = isCollectionTarget
    ? `${options.collection}#${options.id}`
    : `global:${options.global}`
  const collectionSlug = isCollectionTarget ? options.collection : undefined

  const processedLocales = targetLocales.filter((locale) => locale !== defaultLocale)
  const reports: LinkSyncLocaleReport[] = []
  const warnings: string[] = []
  const errors: string[] = []
  const missingAlternates = new Map<string, Set<string>>()
  const normalizePath = (path: string) => path.replace(/\.\d+(?=\.|$)/g, '.[]')

  const allowedIdentifiers = new Set(
    fieldPatterns
      // eslint-disable-next-line regexp/no-unused-capturing-group
      .filter((pattern) => /\.(_?id)$/.test(pattern))
      .map((pattern) => normalizePath(pattern.replace(/\[\]/g, '.[]'))),
  )

  const defaultDoc = await loadLocalizedDocument(
    payload,
    isCollectionTarget
      ? {
          id: options.id,
          collection: options.collection,
          fallbackLocale: false,
          locale: defaultLocale,
        }
      : {
          fallbackLocale: false,
          global: options.global,
          locale: defaultLocale,
        },
  )

  if (!defaultDoc) {
    throw new Error(`Document ${targetLabel} is not available in ${defaultLocale}`)
  }

  // Identifier metadata (id/_id) should never be sent back when updating globals during link
  // synchronization. Some nested menus (such as the Navigation global) include many internal IDs
  // that Payload treats as read-only; keeping them triggers validation errors like
  // "The following field is invalid: id". When field patterns explicitly include identifier
  // fields we keep them so Payload can match existing array items and avoid duplicates; all other
  // identifiers are pruned.

  const defaultLinks = collectLinkOccurrences(defaultDoc, fieldPatterns)
  const defaultLinksByPath = defaultLinks.reduce((acc, entry) => {
    if (!acc.has(entry.path)) {
      acc.set(entry.path, new Set<string>())
    }

    acc.get(entry.path)?.add(entry.value)
    return acc
  }, new Map<string, Set<string>>())
  const defaultLinksByNormalizedPath = defaultLinks.reduce((acc, entry) => {
    const normalized = normalizePath(entry.path)
    if (!acc.has(normalized)) {
      acc.set(normalized, new Set<string>())
    }

    acc.get(normalized)?.add(entry.value)
    return acc
  }, new Map<string, Set<string>>())
  const uniqueDefaultUrls = new Set(defaultLinks.map((entry) => entry.value))

  if (!uniqueDefaultUrls.size) {
    return {
      collection: collectionSlug,
      documentId: isCollectionTarget ? options.id : undefined,
      errors,
      global: isCollectionTarget ? undefined : options.global,
      missingAlternateLocales: [],
      processedLocales,
      processedUrls: 0,
      replacements: 0,
      reports,
      unchangedLocales: processedLocales,
      updatedLocales: [],
      warnings,
    }
  }

  const localeUrlMap = new Map<string, Map<string, string>>()

  for (const url of uniqueDefaultUrls) {
    let alternates = cache.get(url)
    if (!alternates) {
      try {
        alternates = await fetchAlternateLinks(url, { baseUrl: serverURL })
        cache.set(url, alternates)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to fetch alternates'
        warnings.push(`Failed to fetch ${url}: ${message}`)
        alternates = new Map()
        cache.set(url, alternates)
      }
    }

    for (const locale of processedLocales) {
      const nextUrl = selectAlternateForLocale(alternates, locale)
      if (!nextUrl) {
        if (!missingAlternates.has(locale)) {
          missingAlternates.set(locale, new Set())
        }
        missingAlternates.get(locale)?.add(url)
        continue
      }

      if (!localeUrlMap.has(locale)) {
        localeUrlMap.set(locale, new Map())
      }
      localeUrlMap.get(locale)?.set(url, nextUrl)
    }
  }

  const updatedLocales: string[] = []
  const unchangedLocales: string[] = []
  let totalReplacements = 0

  for (const locale of processedLocales) {
    const replacementsForLocale = localeUrlMap.get(locale)
    const localeReport: LinkSyncLocaleReport = {
      errors: [],
      locale,
      missingAlternates: ensureArray(missingAlternates.get(locale)?.values()),
      replacements: 0,
      updated: false,
      warnings: [],
    }

    if (!replacementsForLocale?.size) {
      unchangedLocales.push(locale)
      reports.push(localeReport)
      continue
    }

    const existingLocaleDoc = await loadLocalizedDocument(
      payload,
      isCollectionTarget
        ? {
            id: options.id,
            collection: options.collection,
            fallbackLocale: true,
            locale,
          }
        : {
            fallbackLocale: true,
            global: options.global,
            locale,
          },
    )

    let localeData: unknown = mergeStructuralData(defaultDoc, existingLocaleDoc, {
      matchByIdentity: false,
      preferBaseForUnmatchedIndexedItems: true,
    })

    stripDocumentMetadata(localeData)

    const localeLinks = collectLinkOccurrences(localeData, fieldPatterns)

    let changed = false
    for (const occurrence of localeLinks) {
      const defaultValues =
        defaultLinksByPath.get(occurrence.path) ??
        defaultLinksByNormalizedPath.get(normalizePath(occurrence.path))
      const replacement =
        replacementsForLocale.get(occurrence.value) ??
        Array.from(defaultValues ?? [])
          .map((value) => replacementsForLocale.get(value))
          .find(Boolean)

      if (!replacement) {
        continue
      }

      const result = applyLinkOccurrence(occurrence, defaultDoc, localeData, replacement)
      localeData = result.data
      if (result.changed) {
        localeReport.replacements += 1
        changed = true
      }
    }

    if (!changed) {
      unchangedLocales.push(locale)
      reports.push(localeReport)
      continue
    }

    stripDocumentMetadata(localeData)
    const identifierSafeData = isCollectionTarget
      ? localeData
      : pruneIdentifierFields(localeData, allowedIdentifiers)
    const saveData = (
      isCollectionTarget ? identifierSafeData : cloneWithoutDocumentMetadata(identifierSafeData)
    ) as Record<string, unknown>

    if (!isCollectionTarget) {
      delete saveData.id
      delete saveData._id
    }

    try {
      if (isCollectionTarget) {
        await payload.update({
          id: options.id,
          collection: options.collection,
          data: saveData,
          locale,
          overrideAccess: true,
        })
      } else {
        await payload.updateGlobal({
          slug: options.global,
          data: saveData,
          locale,
          overrideAccess: true,
        })
      }
      localeReport.updated = true
      totalReplacements += localeReport.replacements
      updatedLocales.push(locale)
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to update locale ${locale}`
      localeReport.errors.push(message)
      errors.push(`${targetLabel} (${locale}): ${message}`)
      unchangedLocales.push(locale)
    }

    reports.push(localeReport)
  }

  const missingLocales = Array.from(missingAlternates.entries())
    .filter(([, urls]) => urls.size > 0)
    .map(([locale]) => locale)

  return {
    collection: collectionSlug,
    documentId: isCollectionTarget ? options.id : undefined,
    errors,
    global: isCollectionTarget ? undefined : options.global,
    missingAlternateLocales: missingLocales,
    processedLocales,
    processedUrls: uniqueDefaultUrls.size,
    replacements: totalReplacements,
    reports,
    unchangedLocales,
    updatedLocales,
    warnings,
  }
}
