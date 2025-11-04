import type { Payload } from 'payload'

import type {
  LinkSyncLocaleOverride,
  LinkSyncRequestPayload,
  LinkSyncResponsePayload,
} from './translationTypes.js'

import { getTranslationState } from './translationStateStore.js'
import { looksLikeLink } from '../utils/linkDetection.js'

type ParsedLink = {
  collectionHint?: string
  hasLocaleSegment: boolean
  hash: string
  origin: string | null
  pathSegments: string[]
  query: string
  slug: string
}

type LinkSearchResult = {
  collection: string
  id: string | number
}

type LocaleSlugMap = Map<string, Map<string, string>>

function sanitizeString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizePath(path: string): string {
  if (!path) {
    return '/' // default to root for absolute URLs without path
  }

  const trimmed = path.replace(/\/+/g, '/').trim()
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function parseHref(value: string): { href: string; origin: string | null } {
  const trimmed = value.trim()
  if (!trimmed) {
    return { href: '', origin: null }
  }

  try {
    const parsed = new URL(trimmed)
    return { href: normalizePath(parsed.pathname || '/'), origin: `${parsed.protocol}//${parsed.host}` }
  } catch (_error) {
    return { href: normalizePath(trimmed), origin: null }
  }
}

function stripQueryAndHash(path: string): { hash: string; path: string; query: string } {
  let working = path
  let hash = ''
  let query = ''

  const hashIndex = working.indexOf('#')
  if (hashIndex >= 0) {
    hash = working.slice(hashIndex)
    working = working.slice(0, hashIndex)
  }

  const queryIndex = working.indexOf('?')
  if (queryIndex >= 0) {
    query = working.slice(queryIndex)
    working = working.slice(0, queryIndex)
  }

  return { hash, path: working, query }
}

function parseLink(value: string, locales: string[]): null | ParsedLink {
  const { href, origin } = parseHref(value)

  if (!href || href === '/') {
    return null
  }

  const { hash, path, query } = stripQueryAndHash(href)
  const segments = path
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)

  if (!segments.length) {
    return null
  }

  const [firstSegment] = segments
  const hasLocaleSegment = locales.includes(firstSegment || '')

  let effectiveSegments = segments.slice()
  if (hasLocaleSegment) {
    effectiveSegments = segments.slice(1)
  }

  if (!effectiveSegments.length) {
    return null
  }

  const slug = effectiveSegments[effectiveSegments.length - 1]
  if (!slug) {
    return null
  }

  const collectionHint = effectiveSegments.length > 1 ? effectiveSegments[0] : undefined

  return {
    collectionHint,
    hasLocaleSegment,
    hash,
    origin,
    pathSegments: segments,
    query,
    slug,
  }
}

async function findDocumentForLink(
  payload: Payload,
  slug: string,
  candidates: string[],
  defaultLocale: string,
): Promise<LinkSearchResult | null> {
  for (const collection of candidates) {
    try {
      const result = await payload.find({
        collection,
        draft: true,
        depth: 0,
        fallbackLocale: false,
        limit: 2,
        locale: defaultLocale,
        where: { slug: { equals: slug } },
      })

      const docs = Array.isArray(result.docs) ? result.docs : []
      if (docs.length === 1) {
        const doc = docs[0] as { id?: unknown; _id?: unknown }
        const id = sanitizeIdentifier(doc.id) ?? sanitizeIdentifier(doc._id)
        if (id !== null) {
          return { collection, id }
        }
      }
    } catch (_error) {
      // Ignore individual lookup errors and continue searching other collections
    }
  }

  return null
}

function sanitizeIdentifier(value: unknown): string | number | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length ? trimmed : null
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  return null
}

async function loadLocaleSlugs(
  payload: Payload,
  cache: LocaleSlugMap,
  entry: LinkSearchResult,
  locales: string[],
): Promise<Map<string, string>> {
  const cacheKey = `${entry.collection}#${entry.id}`
  const cached = cache.get(cacheKey)
  if (cached) {
    return cached
  }

  const map = new Map<string, string>()

  await Promise.all(
    locales.map(async (locale) => {
      try {
        const doc = await payload.findByID({
          id: entry.id,
          collection: entry.collection,
          draft: true,
          depth: 0,
          fallbackLocale: false,
          locale,
        })

        const slug = sanitizeString((doc as { slug?: unknown }).slug)
        if (slug) {
          map.set(locale, slug)
        }
      } catch (_error) {
        // Ignore missing locales
      }
    }),
  )

  cache.set(cacheKey, map)
  return map
}

function buildLocalizedPath(
  parsed: ParsedLink,
  targetSlug: string,
  targetLocale: string,
  locales: string[],
): string {
  const segments = parsed.pathSegments.slice()

  if (!segments.length) {
    return targetSlug
  }

  if (parsed.hasLocaleSegment) {
    if (locales.includes(targetLocale)) {
      segments[0] = targetLocale
    }
  }

  if (segments.length) {
    segments[segments.length - 1] = targetSlug
  }

  const path = `/${segments.join('/')}`
  return `${parsed.origin ?? ''}${path}${parsed.query}${parsed.hash}`
}

function groupOverrides(perLocale: Map<string, Map<number, string>>): LinkSyncResponsePayload {
  const locales: LinkSyncResponsePayload['locales'] = []

  for (const [locale, overrides] of perLocale.entries()) {
    const entries: LinkSyncLocaleOverride[] = []
    for (const [index, text] of overrides.entries()) {
      entries.push({ index, text })
    }

    if (entries.length) {
      locales.push({ code: locale, overrides: entries })
    }
  }

  return { locales }
}

export async function generateLinkSyncPlan(
  payload: Payload,
  request: LinkSyncRequestPayload,
): Promise<LinkSyncResponsePayload> {
  const state = getTranslationState()
  const trackedCollections = Object.keys(state.collections)
  const locales = state.locales
  const targetLocales = request.locales.filter((code) => code && code !== request.from)

  if (!targetLocales.length || !trackedCollections.length) {
    return { locales: [] }
  }

  const overrideMap = new Map<string, Map<number, string>>()
  const slugCache: LocaleSlugMap = new Map()

  await Promise.all(
    request.items.map(async (item, index) => {
      if (item.lexical) {
        return
      }

      if (!looksLikeLink(item.text)) {
        return
      }

      const parsed = parseLink(item.text, locales)
      if (!parsed) {
        return
      }

      const collectionCandidates = parsed.collectionHint
        ? trackedCollections.filter((slug) => slug === parsed.collectionHint)
        : trackedCollections

      if (!collectionCandidates.length) {
        return
      }

      const found = await findDocumentForLink(payload, parsed.slug, collectionCandidates, request.from)
      if (!found) {
        return
      }

      const localeSlugs = await loadLocaleSlugs(payload, slugCache, found, targetLocales)

      for (const locale of targetLocales) {
        const slug = localeSlugs.get(locale)
        if (!slug) {
          continue
        }

        const nextPath = buildLocalizedPath(parsed, slug, locale, locales)
        if (!nextPath || nextPath === item.text) {
          continue
        }

        if (!overrideMap.has(locale)) {
          overrideMap.set(locale, new Map())
        }

        overrideMap.get(locale)!.set(index, nextPath)
      }
    }),
  )

  return groupOverrides(overrideMap)
}
