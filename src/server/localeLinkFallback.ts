/**
 * Fallback for internal links that cannot be resolved through alternate
 * (`hreflang`) tags — typically hardcoded route paths such as `/blog`. The
 * candidate simply prefixes (or swaps) the locale segment, and is only used
 * after the target URL is confirmed to exist.
 */

const EXCLUDED_FIRST_SEGMENTS = new Set(['_next', 'admin', 'api', 'media'])

function normalizeLocaleSegment(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, '-')
}

export function buildLocalePathCandidate(
  url: string,
  locale: string,
  options: { baseUrl?: string; knownLocales?: string[] } = {},
): null | string {
  const targetSegment = normalizeLocaleSegment(locale)
  if (!targetSegment) {
    return null
  }

  const knownLocales = new Set(
    (options.knownLocales ?? []).map(normalizeLocaleSegment).filter(Boolean),
  )

  let pathname: string
  let suffix: string
  let origin: null | string = null

  if (url.startsWith('/') && !url.startsWith('//')) {
    const splitIndex = url.split('').findIndex((char) => char === '?' || char === '#')
    pathname = splitIndex === -1 ? url : url.slice(0, splitIndex)
    suffix = splitIndex === -1 ? '' : url.slice(splitIndex)
  } else {
    let parsed: URL
    let base: URL
    try {
      parsed = new URL(url)
      base = new URL(options.baseUrl ?? '')
    } catch (_error) {
      return null
    }

    // Only same-origin absolute URLs are internal links we can localize.
    if (parsed.origin !== base.origin) {
      return null
    }

    origin = parsed.origin
    pathname = parsed.pathname
    suffix = `${parsed.search}${parsed.hash}`
  }

  const hadTrailingSlash = pathname.length > 1 && pathname.endsWith('/')
  const segments = pathname.split('/').filter(Boolean)
  const firstSegment = normalizeLocaleSegment(segments[0] ?? '')

  if (firstSegment === targetSegment) {
    return null
  }

  if (firstSegment && EXCLUDED_FIRST_SEGMENTS.has(firstSegment)) {
    return null
  }

  // Skip asset-like paths (e.g. /files/report.pdf).
  const lastSegment = segments.at(-1) ?? ''
  if (lastSegment.includes('.')) {
    return null
  }

  const nextSegments = knownLocales.has(firstSegment)
    ? [locale, ...segments.slice(1)]
    : [locale, ...segments]

  const nextPath = `/${nextSegments.join('/')}${hadTrailingSlash ? '/' : ''}`
  return `${origin ?? ''}${nextPath}${suffix}`
}

export async function confirmLocalePathCandidate(
  candidate: string,
  options: {
    baseUrl?: string
    /** Shared cache of already-checked candidate URLs. */
    checked?: Map<string, boolean>
    fetchImpl?: typeof fetch
  } = {},
): Promise<boolean> {
  const cached = options.checked?.get(candidate)
  if (cached !== undefined) {
    return cached
  }

  const remember = (value: boolean): boolean => {
    options.checked?.set(candidate, value)
    return value
  }

  let resolved: URL
  try {
    resolved = new URL(candidate)
  } catch (_error) {
    if (!options.baseUrl) {
      return remember(false)
    }

    try {
      resolved = new URL(candidate, options.baseUrl)
    } catch (_innerError) {
      return remember(false)
    }
  }

  const fetcher = options.fetchImpl ?? fetch

  try {
    const response = await fetcher(resolved, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent':
          'payload-content-ops/links (+https://github.com/nielsreijnders/payload-content-ops)',
      },
    })
    return remember(response.ok)
  } catch (_error) {
    return remember(false)
  }
}
