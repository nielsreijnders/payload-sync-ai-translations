import { describe, expect, it, vi } from 'vitest'

import {
  buildLocalePathCandidate,
  confirmLocalePathCandidate,
} from '../../src/server/localeLinkFallback.js'

describe('buildLocalePathCandidate', () => {
  const options = { baseUrl: 'https://example.com', knownLocales: ['en', 'nl', 'de'] }

  it('prefixes root-relative paths with the target locale', () => {
    expect(buildLocalePathCandidate('/blog', 'nl', options)).toBe('/nl/blog')
    expect(buildLocalePathCandidate('/', 'nl', options)).toBe('/nl')
    expect(buildLocalePathCandidate('/blog/post-1', 'nl', options)).toBe('/nl/blog/post-1')
  })

  it('preserves trailing slashes, query strings, and hashes', () => {
    expect(buildLocalePathCandidate('/blog/', 'nl', options)).toBe('/nl/blog/')
    expect(buildLocalePathCandidate('/blog?page=2#latest', 'nl', options)).toBe(
      '/nl/blog?page=2#latest',
    )
  })

  it('swaps an existing known locale prefix instead of stacking prefixes', () => {
    expect(buildLocalePathCandidate('/en/blog', 'nl', options)).toBe('/nl/blog')
    expect(buildLocalePathCandidate('/de/blog/post', 'nl', options)).toBe('/nl/blog/post')
  })

  it('returns null when the path already starts with the target locale', () => {
    expect(buildLocalePathCandidate('/nl/blog', 'nl', options)).toBeNull()
  })

  it('handles same-origin absolute URLs and rejects external ones', () => {
    expect(buildLocalePathCandidate('https://example.com/blog', 'nl', options)).toBe(
      'https://example.com/nl/blog',
    )
    expect(buildLocalePathCandidate('https://other.com/blog', 'nl', options)).toBeNull()
    expect(buildLocalePathCandidate('https://example.com/blog', 'nl', {})).toBeNull()
  })

  it('skips system routes and asset-like paths', () => {
    expect(buildLocalePathCandidate('/api/pages', 'nl', options)).toBeNull()
    expect(buildLocalePathCandidate('/admin/collections', 'nl', options)).toBeNull()
    expect(buildLocalePathCandidate('/media/logo.svg', 'nl', options)).toBeNull()
    expect(buildLocalePathCandidate('/files/report.pdf', 'nl', options)).toBeNull()
  })
})

describe('confirmLocalePathCandidate', () => {
  it('confirms candidates that resolve successfully and caches the result', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }) as Response)
    const checked = new Map<string, boolean>()

    await expect(
      confirmLocalePathCandidate('/nl/blog', {
        baseUrl: 'https://example.com',
        checked,
        fetchImpl,
      }),
    ).resolves.toBe(true)
    await expect(
      confirmLocalePathCandidate('/nl/blog', {
        baseUrl: 'https://example.com',
        checked,
        fetchImpl,
      }),
    ).resolves.toBe(true)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://example.com/nl/blog')
  })

  it('rejects candidates that fail to resolve', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false }) as Response)

    await expect(
      confirmLocalePathCandidate('/nl/missing', {
        baseUrl: 'https://example.com',
        fetchImpl,
      }),
    ).resolves.toBe(false)
  })

  it('rejects relative candidates without a base URL', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }) as Response)

    await expect(confirmLocalePathCandidate('/nl/blog', { fetchImpl })).resolves.toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
