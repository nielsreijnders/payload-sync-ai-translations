import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TranslateReviewRequestPayload } from '../../src/server/translationTypes.js'

import { generateTranslationReview } from '../../src/server/translationReviewService.js'
import { serializeLexicalValue, splitLexicalText } from '../../src/utils/lexical.js'
import { MAX_CHARS_PER_CHUNK } from '../../src/utils/localizedFields.js'
import { openAiTranslateTexts } from '../../src/server/openAiTranslationClient.js'

vi.mock('../../src/server/openAiTranslationClient.js', () => ({
  openAiDetectMissingInformation: vi.fn().mockResolvedValue([]),
  openAiTranslateTexts: vi.fn().mockResolvedValue([]),
}))

const translateTextsMock = vi.mocked(openAiTranslateTexts)

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

  it('splits oversized lexical suggestions before calling the translator', async () => {
    const paragraphs = Array.from({ length: 24 }, (_, index) => `Paragraaf ${index} ${'y'.repeat(120)}`)
    const lexicalValue = {
      root: {
        type: 'root',
        direction: 'ltr',
        format: '',
        indent: 0,
        version: 1,
        children: paragraphs.map((text) => ({
          type: 'paragraph',
          direction: 'ltr',
          format: '',
          indent: 0,
          textFormat: 0,
          textStyle: '',
          version: 1,
          children: [
            {
              type: 'text',
              detail: 0,
              format: 0,
              mode: 'normal',
              style: '',
              text,
              version: 1,
            },
          ],
        })),
      },
    }

    const serialized = serializeLexicalValue(lexicalValue)
    expect(serialized).not.toBeNull()
    const lexicalText = serialized?.text ?? ''
    expect(lexicalText.length).toBeGreaterThan(MAX_CHARS_PER_CHUNK)

    const segments = splitLexicalText(lexicalText, MAX_CHARS_PER_CHUNK)
    expect(segments.length).toBeGreaterThan(1)

    const translatedSegments = segments.map((segment) =>
      segment.replace(/\[\[LEX-(\d+)\]\]([\s\S]*?)\[\[\/LEX-\1\]\]/g, (_match, token) => {
        return `[[LEX-${token}]]Suggestie-${token}[[/LEX-${token}]]`
      }),
    )

    const payloadMock = {
      findByID: vi.fn<Payload['findByID']>().mockImplementation(async ({ locale }) => {
        if (locale === 'en') {
          return { id: 'page-2', content: lexicalValue }
        }

        return { id: 'page-2' }
      }),
      logger: { error: vi.fn(), info: vi.fn() },
    } satisfies Partial<Payload>

    translateTextsMock.mockResolvedValueOnce(translatedSegments)

    const request: TranslateReviewRequestPayload = {
      id: 'page-2',
      collection: 'pages',
      from: 'en',
      locales: ['nl'],
      items: [
        {
          lexical: true,
          path: 'content',
          text: lexicalText,
        },
      ],
    }

    const review = await generateTranslationReview(payloadMock as Payload, request)

    expect(translateTextsMock).toHaveBeenCalledWith(segments, 'en', 'nl')
    const [locale] = review.locales
    expect(locale.translateIndexes).toEqual([0])
    expect(locale.suggestions?.[0]).toEqual({ index: 0, text: translatedSegments.join('') })
  })
})
