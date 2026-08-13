import type { Payload } from 'payload'

import type { LinkSyncLocaleReport, LinkSyncResult } from './linkSyncTypes.js'

import { logDebug } from './debugSettings.js'
import {
  cloneWithoutDocumentMetadata,
  loadLocalizedDocument,
  stripDocumentMetadata,
} from './documentUtils.js'
import {
  collectConcreteLocalizedContainerPaths,
  pruneIdentifierFields,
} from './identifierPruning.js'
import { fetchAlternateLinks, selectAlternateForLocale } from './linkAlternate.js'
import { applyLinkOccurrence, collectLinkOccurrences } from './linkCollector.js'
import { buildLocalePathCandidate, confirmLocalePathCandidate } from './localeLinkFallback.js'
import { cloneLocaleData } from './localeStructure.js'
import { readDocumentStatus, resolveSaveStatusFlags } from './saveStatus.js'

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
  localizedContainerPatterns?: string[]
  payload: Payload
  serverURL?: string
  targetLocales: string[]
} & (CollectionLinkOptions | GlobalLinkOptions)

type FetchCache = Map<string, Map<string, string>>

function ensureArray<T>(value: Iterable<T> | undefined): T[] {
  return value ? Array.from(value) : []
}

/**
 * Same-origin links are stored as site-relative paths. Alternate (hreflang)
 * tags expose absolute URLs for whatever host rendered the page, so writing
 * them verbatim bakes the environment into the content — a sync against a
 * dev server would store `http://localhost:3000/...` links in production
 * data. External origins pass through untouched.
 */
function toSiteRelativeUrl(url: string, baseUrl?: string): string {
  if (!baseUrl || !/^https?:\/\//i.test(url)) {
    return url
  }

  try {
    const parsed = new URL(url)
    const base = new URL(baseUrl)

    if (parsed.origin !== base.origin) {
      return url
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}` || '/'
  } catch (_error) {
    return url
  }
}

export async function synchronizeLinksForDocument(
  options: LinkSyncOptions,
  cache: FetchCache = new Map(),
  checkedCandidates: Map<string, boolean> = new Map(),
): Promise<LinkSyncResult> {
  const { defaultLocale, fieldPatterns, payload, serverURL, targetLocales } = options
  const isCollectionTarget = 'collection' in options
  const targetLabel = isCollectionTarget
    ? `${options.collection}#${options.id}`
    : `global:${options.global}`
  const collectionSlug = isCollectionTarget ? options.collection : undefined

  const processedLocales = targetLocales.filter((locale) => locale !== defaultLocale)
  const knownLocales = Array.from(new Set([defaultLocale, ...targetLocales]))
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

  const allUrls = new Set<string>()
  const defaultLinks = collectLinkOccurrences(defaultDoc, fieldPatterns)
  defaultLinks.forEach((entry) => {
    allUrls.add(entry.value)
  })

  const localeDocs = new Map<string, unknown>()

  for (const locale of processedLocales) {
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

    if (!existingLocaleDoc) {
      localeDocs.set(locale, null)
      continue
    }

    localeDocs.set(locale, existingLocaleDoc)

    const localeLinks = collectLinkOccurrences(existingLocaleDoc, fieldPatterns)
    localeLinks.forEach((entry) => {
      allUrls.add(entry.value)
    })
  }

  if (!allUrls.size) {
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

  for (const url of allUrls) {
    let alternates = cache.get(url)

    logDebug(payload, `Resolving alternates for ${url}`)

    if (!alternates) {
      try {
        alternates = await fetchAlternateLinks(url, { baseUrl: serverURL })
        logDebug(payload, `Alternates for ${url}`, Array.from(alternates.entries()))
        cache.set(url, alternates)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to fetch alternates'
        warnings.push(`Failed to fetch ${url}: ${message}`)
        alternates = new Map()
        cache.set(url, alternates)
      }
    }

    for (const locale of processedLocales) {
      let nextUrl = selectAlternateForLocale(alternates, locale)

      // Hardcoded internal paths (e.g. /blog) usually expose no alternate
      // tags. Fall back to the locale-prefixed path, but only when that URL
      // actually resolves.
      if (!nextUrl) {
        const candidate = buildLocalePathCandidate(url, locale, {
          baseUrl: serverURL,
          knownLocales,
        })

        if (candidate && candidate !== url) {
          const exists = await confirmLocalePathCandidate(candidate, {
            baseUrl: serverURL,
            checked: checkedCandidates,
          })

          if (exists) {
            nextUrl = candidate
            // Remember the confirmed fallback as this URL's alternate so later
            // documents in the same run resolve it without re-checking.
            alternates.set(locale, candidate)
            logDebug(payload, `Locale path fallback for ${url} (${locale})`, candidate)
          }
        }
      }

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
      localeUrlMap.get(locale)?.set(url, toSiteRelativeUrl(nextUrl, serverURL))
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

    const existingLocaleDoc = localeDocs.get(locale) ?? null

    let localeData: unknown = cloneLocaleData(existingLocaleDoc ?? defaultDoc)
    stripDocumentMetadata(localeData)

    let changed = false

    // Walk the default document's link occurrences so replacements follow the
    // current default URLs and land on the id-normalized path in the locale
    // data, even when array items were reordered or the locale still holds an
    // outdated localized URL.
    for (const occurrence of defaultLinks) {
      const replacement = replacementsForLocale.get(occurrence.value)

      if (!replacement || replacement === occurrence.value) {
        continue
      }

      const applied = applyLinkOccurrence(occurrence, defaultDoc, localeData, replacement)

      if (!applied.changed) {
        continue
      }

      localeData = applied.data
      localeReport.replacements += 1
      changed = true
    }

    if (!changed) {
      unchangedLocales.push(locale)
      reports.push(localeReport)
      continue
    }

    stripDocumentMetadata(localeData)
    const identifierSafeData = isCollectionTarget
      ? localeData
      : pruneIdentifierFields(localeData, {
          allowedPatterns: allowedIdentifiers,
          localizedContainers: collectConcreteLocalizedContainerPaths(
            localeData,
            options.localizedContainerPatterns,
          ),
        })
    const saveData = (
      isCollectionTarget ? identifierSafeData : cloneWithoutDocumentMetadata(identifierSafeData)
    ) as Record<string, unknown>

    if (!isCollectionTarget) {
      delete saveData.id
      delete saveData._id
    }

    // Mirror the source document's publish state: published sources publish
    // this locale only, never-published sources stay drafts.
    const statusFlags = resolveSaveStatusFlags(readDocumentStatus(defaultDoc), locale)
    const dataToSave = statusFlags.data ? { ...saveData, ...statusFlags.data } : saveData

    try {
      if (isCollectionTarget) {
        await payload.update({
          id: options.id,
          collection: options.collection,
          data: dataToSave,
          locale,
          overrideAccess: true,
          ...(statusFlags.draft ? { draft: true } : {}),
          ...(statusFlags.publishSpecificLocale
            ? { publishSpecificLocale: statusFlags.publishSpecificLocale }
            : {}),
        })
      } else {
        await payload.updateGlobal({
          slug: options.global,
          data: dataToSave,
          locale,
          overrideAccess: true,
          ...(statusFlags.draft ? { draft: true } : {}),
          ...(statusFlags.publishSpecificLocale
            ? { publishSpecificLocale: statusFlags.publishSpecificLocale }
            : {}),
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
    processedUrls: allUrls.size,
    replacements: totalReplacements,
    reports,
    unchangedLocales,
    updatedLocales,
    warnings,
  }
}
