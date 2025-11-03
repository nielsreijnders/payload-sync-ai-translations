import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TranslateReviewRequestPayload } from '../../src/server/translationTypes.js'

import { generateTranslationReview } from '../../src/server/translationReviewService.js'

vi.mock('../../src/server/openAiTranslationClient.js', () => ({
  openAiDetectMissingInformation: vi.fn().mockResolvedValue([]),
  openAiTranslateTexts: vi.fn().mockResolvedValue([]),
}))

describe('generateTranslationReview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
})
