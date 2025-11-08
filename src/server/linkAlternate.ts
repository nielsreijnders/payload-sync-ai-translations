import { parse } from 'node-html-parser'

export type AlternateMap = Map<string, string>

function normalizeLocale(code: string): string {
  return code.trim().toLowerCase().replace(/_/g, '-')
}

function resolveUrl(candidate: string, base: URL): string {
  try {
    return new URL(candidate, base).toString()
  } catch (_error) {
    return candidate
  }
}

export async function fetchAlternateLinks(
  url: string,
  options?: { baseUrl?: string; fetchImpl?: typeof fetch },
): Promise<AlternateMap> {
  const fetcher = options?.fetchImpl ?? fetch
  const base = options?.baseUrl

  let resolved: URL
  try {
    resolved = new URL(url)
  } catch (_error) {
    if (!base) {
      throw new Error(`Cannot resolve URL ${url}`)
    }
    resolved = new URL(url, base)
  }

  const response = await fetcher(resolved, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'User-Agent': 'payload-sync-ai-translations/links (+https://github.com/nielsreijnders/payload-sync-ai-translations)',
    },
  })

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`)
  }

  const html = await response.text()
  const root = parse(html)
  const alternates: AlternateMap = new Map()

  const linkNodes = root.querySelectorAll('link[rel="alternate"]')
  for (const node of linkNodes) {
    const hreflang = node.getAttribute('hreflang')
    const href = node.getAttribute('href')
    if (!hreflang || !href) {
      continue
    }

    const normalized = normalizeLocale(hreflang)
    if (!normalized) {
      continue
    }

    alternates.set(normalized, resolveUrl(href, resolved))
  }

  const metaNodes = root.querySelectorAll('meta[property="og:locale:alternate"]')
  for (const node of metaNodes) {
    const content = node.getAttribute('content')
    const urlAttr = node.getAttribute('data-url')
    if (!content || !urlAttr) {
      continue
    }

    const normalized = normalizeLocale(content)
    if (!normalized) {
      continue
    }

    alternates.set(normalized, resolveUrl(urlAttr, resolved))
  }

  return alternates
}

function normalizeCandidates(alternates: AlternateMap): AlternateMap {
  const normalized: AlternateMap = new Map()
  for (const [key, value] of alternates) {
    const normalizedKey = normalizeLocale(key)
    if (!normalizedKey) {
      continue
    }

    if (!normalized.has(normalizedKey)) {
      normalized.set(normalizedKey, value)
    }
  }
  return normalized
}

export function selectAlternateForLocale(
  alternates: AlternateMap,
  locale: string,
): null | string {
  const normalizedAlternates = normalizeCandidates(alternates)
  const normalizedLocale = normalizeLocale(locale)

  const direct = normalizedAlternates.get(normalizedLocale)
  if (direct) {
    return direct
  }

  const localePrimary = normalizedLocale.split('-')[0]

  for (const [code, href] of normalizedAlternates) {
    if (code.split('-')[0] === localePrimary) {
      return href
    }
  }

  return null
}
