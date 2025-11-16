import type { Payload } from 'payload'

import type { LinkSyncLocaleReport, LinkSyncResult } from './linkSyncTypes.js'

import { loadLocalizedDocument, stripDocumentMetadata } from './documentUtils.js'
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

type LinkSyncOptions = (CollectionLinkOptions | GlobalLinkOptions) & {
  defaultLocale: string
  fieldPatterns: string[]
  payload: Payload
  serverURL?: string
  targetLocales: string[]
}

type FetchCache = Map<string, Map<string, string>>

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
          global: options.global,
          fallbackLocale: false,
          locale: defaultLocale,
        },
  )

  if (!defaultDoc) {
    throw new Error(`Document ${targetLabel} is not available in ${defaultLocale}`)
  }

  const defaultLinks = collectLinkOccurrences(defaultDoc, fieldPatterns)
  const uniqueDefaultUrls = new Set(defaultLinks.map((entry) => entry.value))

  if (!uniqueDefaultUrls.size) {
    return {
      collection: collectionSlug,
      documentId: isCollectionTarget ? options.id : undefined,
      global: isCollectionTarget ? undefined : options.global,
      errors,
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
            global: options.global,
            fallbackLocale: true,
            locale,
          },
    )

    let localeData: unknown = mergeStructuralData(defaultDoc, existingLocaleDoc)
    stripDocumentMetadata(localeData)

    const localeLinks = collectLinkOccurrences(localeData, fieldPatterns)

    let changed = false
    for (const occurrence of localeLinks) {
      const replacement = replacementsForLocale.get(occurrence.value)
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

    try {
      if (isCollectionTarget) {
        await payload.update({
          id: options.id,
          collection: options.collection,
          data: localeData as Record<string, unknown>,
          locale,
          overrideAccess: true,
        })
      } else {
        await payload.updateGlobal({
          slug: options.global,
          data: localeData as Record<string, unknown>,
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
    global: isCollectionTarget ? undefined : options.global,
    errors,
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
