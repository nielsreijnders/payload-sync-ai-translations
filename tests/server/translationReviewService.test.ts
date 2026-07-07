import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TranslateReviewRequestPayload } from '../../src/server/translationTypes.js'

import {
  openAiDetectMissingInformation,
  openAiTranslateTexts,
} from '../../src/server/openAiTranslationClient.js'
import {
  dropNoopReviewEntries,
  generateTranslationReview,
} from '../../src/server/translationReviewService.js'

vi.mock('../../src/server/openAiTranslationClient.js', () => ({
  openAiDetectMissingInformation: vi.fn().mockResolvedValue([]),
  openAiTranslateTexts: vi.fn().mockResolvedValue([]),
  shouldPreserveOriginalValue: vi.fn((value: string) => value.trim().startsWith('/')),
}))

describe('generateTranslationReview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(openAiDetectMissingInformation).mockResolvedValue([])
    vi.mocked(openAiTranslateTexts).mockResolvedValue([])
  })

  it('detects missing translations when flexible content entries are misaligned', async () => {
    const baseDoc = {
      id: 'page-1',
      layout: [
        {
          _id: 'hero-1',
          blockType: 'hero',
          title: 'Primary heading',
        },
        {
          _id: 'feature-1',
          blockType: 'feature',
          title: 'Key features',
        },
      ],
    }

    const payloadMock = {
      findByID: vi.fn<Payload['findByID']>().mockImplementation(async ({ locale }) => {
        if (locale === 'en') {
          return baseDoc
        }

        return {
          id: 'page-1',
          layout: [
            {
              _id: 'feature-1',
              blockType: 'feature',
              title: 'Key features (existing)',
            },
          ],
        }
      }),
      logger: { error: vi.fn(), info: vi.fn() },
    } satisfies Partial<Payload>

    const request: TranslateReviewRequestPayload = {
      id: 'page-1',
      collection: 'pages',
      from: 'en',
      locales: ['nl'],
      items: [
        {
          lexical: false,
          path: 'layout.0.title',
          text: 'Primary heading',
        },
        {
          lexical: false,
          path: 'layout.1.title',
          text: 'Key features',
        },
      ],
    }

    const review = await generateTranslationReview(payloadMock as Payload, request)

    expect(review.locales).toHaveLength(1)
    const [locale] = review.locales
    expect(locale.code).toBe('nl')
    expect(locale.translateIndexes).toContain(0)
    expect(locale.translateIndexes).not.toContain(1)
  })

  it('treats target text that matches the source text as untranslated', async () => {
    const heading = {
      root: {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              {
                type: 'text',
                text: 'Supporting HealthyProteins in shaping strategic focus for growth',
              },
            ],
          },
        ],
      },
    }

    const baseDoc = {
      id: 'case-1',
      heroes: [
        {
          blockType: 'HeroText',
          heading,
        },
      ],
      slug: '/en/cases/supporting-healthyproteins-in-shaping-strategic-focus-for-growth',
    }

    const payloadMock = {
      findByID: vi.fn<Payload['findByID']>().mockImplementation(async ({ locale }) => {
        if (locale === 'en') {
          return baseDoc
        }

        return {
          id: 'case-1',
          heroes: [
            {
              blockType: 'HeroText',
              heading,
            },
          ],
          slug: '/en/cases/supporting-healthyproteins-in-shaping-strategic-focus-for-growth',
        }
      }),
      logger: { error: vi.fn(), info: vi.fn() },
    } satisfies Partial<Payload>

    const request: TranslateReviewRequestPayload = {
      id: 'case-1',
      collection: 'cases',
      from: 'en',
      locales: ['nl'],
      items: [
        {
          lexical: true,
          path: 'heroes.0.heading',
          text: '[[LEX-0]]Supporting HealthyProteins in shaping strategic focus for growth[[/LEX-0]]',
        },
        {
          lexical: false,
          path: 'slug',
          text: '/en/cases/supporting-healthyproteins-in-shaping-strategic-focus-for-growth',
        },
      ],
    }

    const review = await generateTranslationReview(payloadMock as Payload, request)

    expect(review.locales).toHaveLength(1)
    const [locale] = review.locales
    expect(locale.translateIndexes).toContain(0)
    expect(locale.translateIndexes).not.toContain(1)
    expect(locale.existingCount).toBe(1)
    expect(openAiDetectMissingInformation).toHaveBeenCalledTimes(1)
    expect(openAiTranslateTexts).toHaveBeenCalledWith(
      ['[[LEX-0]]Supporting HealthyProteins in shaping strategic focus for growth[[/LEX-0]]'],
      'en',
      'nl',
      { customPrompt: undefined },
    )
  })

  it('drops mismatches whose suggestion equals the existing translation', async () => {
    const baseDoc = {
      id: 'page-2',
      title: 'Level up your AI-assisted translation workflow.',
    }

    const payloadMock = {
      create: vi.fn(),
      find: vi.fn().mockResolvedValue({ docs: [] }),
      findByID: vi.fn<Payload['findByID']>().mockImplementation(async ({ locale }) => {
        if (locale === 'en') {
          return baseDoc
        }

        return {
          id: 'page-2',
          title: 'Verbeter uw AI-ondersteunde vertaalworkflow.',
        }
      }),
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      update: vi.fn(),
    } satisfies Partial<Payload>

    // The AI flags the field, but its own suggestion is identical to the
    // existing translation — applying it would change nothing.
    vi.mocked(openAiDetectMissingInformation).mockResolvedValue([
      { index: 0, missing: true, reason: "Translation omits 'Level up your' phrase." },
    ])
    vi.mocked(openAiTranslateTexts).mockResolvedValue([
      'Verbeter uw AI-ondersteunde vertaalworkflow.',
    ])

    const request: TranslateReviewRequestPayload = {
      id: 'page-2',
      collection: 'pages',
      from: 'en',
      locales: ['nl'],
      items: [
        {
          lexical: false,
          path: 'title',
          text: 'Level up your AI-assisted translation workflow.',
        },
      ],
    }

    const review = await generateTranslationReview(payloadMock as unknown as Payload, request)

    const [locale] = review.locales
    expect(locale.mismatches).toHaveLength(0)
    expect(locale.translateIndexes).toHaveLength(0)
    expect(locale.suggestions).toBeUndefined()
    // The locale is confirmed in sync, so a fresh snapshot must be recorded.
    expect(payloadMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'ai-translation-sync',
        data: expect.objectContaining({ locale: 'nl', target: 'pages:page-2' }),
      }),
    )
  })

  it('keeps mismatches whose suggestion actually changes the translation', async () => {
    const baseDoc = {
      id: 'page-3',
      title: 'Order now!',
    }

    const payloadMock = {
      create: vi.fn(),
      find: vi.fn().mockResolvedValue({ docs: [] }),
      findByID: vi.fn<Payload['findByID']>().mockImplementation(async ({ locale }) => {
        if (locale === 'en') {
          return baseDoc
        }

        return {
          id: 'page-3',
          title: 'Bestel nu',
        }
      }),
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      update: vi.fn(),
    } satisfies Partial<Payload>

    vi.mocked(openAiDetectMissingInformation).mockResolvedValue([
      { index: 0, missing: true, reason: 'Translation is missing the exclamation emphasis.' },
    ])
    vi.mocked(openAiTranslateTexts).mockResolvedValue(['Bestel nu!'])

    const request: TranslateReviewRequestPayload = {
      id: 'page-3',
      collection: 'pages',
      from: 'en',
      locales: ['nl'],
      items: [
        {
          lexical: false,
          path: 'title',
          text: 'Order now!',
        },
      ],
    }

    const review = await generateTranslationReview(payloadMock as unknown as Payload, request)

    const [locale] = review.locales
    expect(locale.mismatches).toHaveLength(1)
    expect(locale.suggestions).toEqual([{ index: 0, text: 'Bestel nu!' }])
    // Locale still has work, so no snapshot refresh yet.
    expect(payloadMock.create).not.toHaveBeenCalled()
  })
})

describe('dropNoopReviewEntries', () => {
  const mismatch = {
    defaultText: 'Source',
    existingText: 'Bestaande vertaling',
    index: 3,
    path: 'title',
    reason: 'Something missing.',
  }

  it('removes entries whose suggestion equals the existing translation', () => {
    const result = dropNoopReviewEntries({
      mismatches: [mismatch],
      suggestions: [{ index: 3, text: 'Bestaande  vertaling ' }],
      translateIndexes: [3],
    })

    expect(result.mismatches).toHaveLength(0)
    expect(result.suggestions).toHaveLength(0)
    expect(result.translateIndexes).toHaveLength(0)
  })

  it('keeps entries whose suggestion differs', () => {
    const result = dropNoopReviewEntries({
      mismatches: [mismatch],
      suggestions: [{ index: 3, text: 'Nieuwe vertaling' }],
      translateIndexes: [3],
    })

    expect(result.mismatches).toHaveLength(1)
    expect(result.translateIndexes).toEqual([3])
  })

  it('keeps entries without a suggestion and untouched indexes', () => {
    const result = dropNoopReviewEntries({
      mismatches: [mismatch],
      suggestions: [],
      translateIndexes: [1, 3],
    })

    expect(result.mismatches).toHaveLength(1)
    expect(result.translateIndexes).toEqual([1, 3])
  })
})
