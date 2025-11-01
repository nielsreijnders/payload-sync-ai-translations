import type { Payload } from 'payload'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { streamTranslations } from './stream.js'
import type { TranslateRequestPayload } from './types.js'
import { openAiTranslateTexts } from './openai.js'

vi.mock('./openai.js', () => ({
  openAiTranslateTexts: vi.fn(),
}))

const translateTextsMock = vi.mocked(openAiTranslateTexts)

describe('streamTranslations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('preserves blockType metadata when translating block fields', async () => {
    const baseDoc = {
      id: '1',
      layout: [
        {
          blockType: 'hero',
          title: 'Hello world',
        },
      ],
    }

    const payloadMock = {
      findByID: vi
        .fn<Payload['findByID']>()
        .mockImplementation(async ({ locale }) => {
          if (locale === 'en') {
            return baseDoc
          }

          return { id: '1' }
        }),
      update: vi.fn<Payload['update']>(async (args) => args),
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      },
    } satisfies Partial<Payload>

    translateTextsMock.mockResolvedValueOnce(['Hallo wereld'])

    const request: TranslateRequestPayload = {
      collection: 'pages',
      from: 'en',
      id: '1',
      locales: [
        {
          code: 'nl',
          chunks: [
            [
              {
                lexical: false,
                path: 'layout.0.title',
                text: 'Hello world',
              },
            ],
          ],
        },
      ],
    }

    const events: unknown[] = []
    for await (const event of streamTranslations(payloadMock as Payload, request)) {
      events.push(event)
    }

    expect(translateTextsMock).toHaveBeenCalledWith(['Hello world'], 'en', 'nl')
    expect(payloadMock.update).toHaveBeenCalledTimes(1)
    expect(payloadMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'pages',
        id: '1',
        locale: 'nl',
        overrideAccess: true,
        data: {
          layout: [
            {
              blockType: 'hero',
              title: 'Hallo wereld',
            },
          ],
        },
      }),
    )

    expect(events).toEqual([
      { completed: 1, locale: 'nl', total: 1, type: 'progress' },
      { locale: 'nl', type: 'applied' },
      { type: 'done' },
    ])
  })

  it('updates nested group fields with translated values', async () => {
    const baseDoc = {
      id: '1',
      settings: {
        hero: {
          headline: 'Greetings',
          nested: {
            description: 'Welcome visitor',
          },
        },
      },
    }

    const payloadMock = {
      findByID: vi
        .fn<Payload['findByID']>()
        .mockImplementation(async ({ locale }) => {
          if (locale === 'en') {
            return baseDoc
          }

          return { id: '1', settings: {} }
        }),
      update: vi.fn<Payload['update']>(async (args) => args),
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      },
    } satisfies Partial<Payload>

    translateTextsMock
      .mockResolvedValueOnce(['Hallo daar', 'Welkom bezoeker'])

    const request: TranslateRequestPayload = {
      collection: 'pages',
      from: 'en',
      id: '1',
      locales: [
        {
          code: 'nl',
          chunks: [
            [
              {
                lexical: false,
                path: 'settings.hero.headline',
                text: 'Greetings',
              },
              {
                lexical: false,
                path: 'settings.hero.nested.description',
                text: 'Welcome visitor',
              },
            ],
          ],
        },
      ],
    }

    const events: unknown[] = []
    for await (const event of streamTranslations(payloadMock as Payload, request)) {
      events.push(event)
    }

    expect(translateTextsMock).toHaveBeenCalledWith(
      ['Greetings', 'Welcome visitor'],
      'en',
      'nl',
    )

    expect(payloadMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          settings: {
            hero: {
              headline: 'Hallo daar',
              nested: {
                description: 'Welkom bezoeker',
              },
            },
          },
        },
      }),
    )

    expect(events).toEqual([
      { completed: 2, locale: 'nl', total: 2, type: 'progress' },
      { locale: 'nl', type: 'applied' },
      { type: 'done' },
    ])
  })

  it('emits an error event when translator output length mismatches the chunk', async () => {
    const baseDoc = {
      id: '1',
      title: 'Hello world',
    }

    const payloadMock = {
      findByID: vi
        .fn<Payload['findByID']>()
        .mockImplementation(async ({ locale }) => {
          if (locale === 'en') {
            return baseDoc
          }

          return { id: '1' }
        }),
      update: vi.fn<Payload['update']>(async (args) => args),
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      },
    } satisfies Partial<Payload>

    translateTextsMock.mockResolvedValueOnce([])

    const request: TranslateRequestPayload = {
      collection: 'pages',
      from: 'en',
      id: '1',
      locales: [
        {
          code: 'nl',
          chunks: [
            [
              {
                lexical: false,
                path: 'title',
                text: 'Hello world',
              },
            ],
          ],
        },
      ],
    }

    const events: unknown[] = []
    for await (const event of streamTranslations(payloadMock as Payload, request)) {
      events.push(event)
    }

    expect(events).toEqual([
      {
        message: 'Translator mismatch: expected 1, received 0',
        type: 'error',
      },
    ])
    expect(payloadMock.update).not.toHaveBeenCalled()
    expect(payloadMock.logger?.error).toHaveBeenCalledWith(
      '[AI Translate] Translation mismatch for pages#1 (nl).',
    )
  })
})
