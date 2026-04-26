import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TranslateReviewRequestPayload } from '../../src/server/translationTypes.js'

import {
  openAiDetectMissingInformation,
  openAiTranslateTexts,
} from '../../src/server/openAiTranslationClient.js'
import { generateTranslationReview } from '../../src/server/translationReviewService.js'

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
})
