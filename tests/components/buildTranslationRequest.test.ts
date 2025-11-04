import { describe, expect, it } from 'vitest'

import { buildTranslationRequest } from '../../src/components/auto-translate-button/utils/buildTranslationRequest.js'
import type { LocaleTranslationSelection } from '../../src/components/auto-translate-button/hooks/types.js'

describe('buildTranslationRequest', () => {
  const sampleItems = [
    { lexical: false, path: 'title', text: 'Hello world' },
  ]

  const sampleLocales: LocaleTranslationSelection[] = [
    { code: 'nl', overrides: [], translateIndexes: [0] },
  ]

  it('preserves numeric identifiers without coercion', () => {
    const request = buildTranslationRequest(sampleItems, sampleLocales, {
      collectionSlug: 'pages',
      defaultLocale: 'en',
      id: 42,
    })

    expect(request.id).toBe(42)
    expect(typeof request.id).toBe('number')
  })

  it('trims string identifiers', () => {
    const request = buildTranslationRequest(sampleItems, sampleLocales, {
      collectionSlug: 'pages',
      defaultLocale: 'en',
      id: '  abc123  ',
    })

    expect(request.id).toBe('abc123')
  })

  it('throws when identifier is missing', () => {
    expect(() =>
      buildTranslationRequest(sampleItems, sampleLocales, {
        collectionSlug: 'pages',
        defaultLocale: 'en',
        id: '   ',
      }),
    ).toThrowError('Document ID is missing.')
  })
})
