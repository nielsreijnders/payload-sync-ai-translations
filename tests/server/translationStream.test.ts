import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TranslateRequestPayload } from '../../src/server/translationTypes.js'

import { openAiTranslateTexts } from '../../src/server/openAiTranslationClient.js'
import { streamTranslations } from '../../src/server/translationStream.js'
import { serializeLexicalValue, splitLexicalText } from '../../src/utils/lexical.js'
import { MAX_CHARS_PER_CHUNK } from '../../src/utils/localizedFields.js'
import { tabbedBlockDocument } from '../fixtures/tabbedBlockLexical.js'

vi.mock('../../src/server/openAiTranslationClient.js', () => ({
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
      findByID: vi.fn<Payload['findByID']>().mockImplementation(async ({ locale }) => {
        if (locale === 'en') {
          return baseDoc
        }

        return { id: '1' }
      }),
      logger: {
        error: vi.fn(),
        info: vi.fn(),
      },
      update: vi.fn<Payload['update']>(async (args) => args),
    } satisfies Partial<Payload>

    translateTextsMock.mockResolvedValueOnce(['Hallo wereld'])

    const request: TranslateRequestPayload = {
      id: '1',
      collection: 'pages',
      from: 'en',
      locales: [
        {
          chunks: [
            [
              {
                lexical: false,
                path: 'layout.0.title',
                text: 'Hello world',
              },
            ],
          ],
          code: 'nl',
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
        id: '1',
        collection: 'pages',
        data: expect.objectContaining({
          layout: [
            {
              blockType: 'hero',
              title: 'Hallo wereld',
            },
          ],
        }),
        locale: 'nl',
        overrideAccess: true,
      }),
    )

    expect(events).toEqual([
      { type: 'progress', completed: 1, locale: 'nl', total: 1 },
      { type: 'applied', locale: 'nl' },
      { type: 'done' },
    ])
  })

  it('strips document identifiers before saving translations', async () => {
    const baseDoc = {
      id: 91,
      title: 'Example product',
    }

    const payloadMock = {
      findByID: vi.fn<Payload['findByID']>().mockResolvedValue(baseDoc),
      logger: {
        error: vi.fn(),
        info: vi.fn(),
      },
      update: vi.fn<Payload['update']>(async (args) => args),
    } satisfies Partial<Payload>

    translateTextsMock.mockResolvedValueOnce(['Voorbeeld product'])

    const request: TranslateRequestPayload = {
      id: 91,
      collection: 'products',
      from: 'en',
      locales: [
        {
          chunks: [
            [
              {
                lexical: false,
                path: 'title',
                text: 'Example product',
              },
            ],
          ],
          code: 'nl',
        },
      ],
    }

    for await (const _event of streamTranslations(payloadMock as Payload, request)) {
      // exhaust generator
    }

    expect(payloadMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ id: expect.anything(), _id: expect.anything() }),
      }),
    )
  })

  it('copies missing flexible content blocks from the base document', async () => {
    const baseDoc = {
      id: '2',
      layout: [
        {
          blockType: 'hero',
          title: 'Primary heading',
        },
        {
          blockType: 'divider',
          style: 'simple',
        },
      ],
    }

    const payloadMock = {
      findByID: vi.fn<Payload['findByID']>().mockImplementation(async ({ locale }) => {
        if (locale === 'en') {
          return baseDoc
        }

        return { id: '2' }
      }),
      logger: {
        error: vi.fn(),
        info: vi.fn(),
      },
      update: vi.fn<Payload['update']>(async (args) => args),
    } satisfies Partial<Payload>

    translateTextsMock.mockResolvedValueOnce(['Primaire heading'])

    const request: TranslateRequestPayload = {
      id: '2',
      collection: 'pages',
      from: 'en',
      locales: [
        {
          chunks: [
            [
              {
                lexical: false,
                path: 'layout.0.title',
                text: 'Primary heading',
              },
            ],
          ],
          code: 'nl',
        },
      ],
    }

    const events: unknown[] = []
    for await (const event of streamTranslations(payloadMock as Payload, request)) {
      events.push(event)
    }

    expect(payloadMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          layout: [
            {
              blockType: 'hero',
              title: 'Primaire heading',
            },
            {
              blockType: 'divider',
              style: 'simple',
            },
          ],
        }),
        id: '2',
        locale: 'nl',
      }),
    )

    expect(events).toEqual([
      { type: 'progress', completed: 1, locale: 'nl', total: 1 },
      { type: 'applied', locale: 'nl' },
      { type: 'done' },
    ])
  })

  it('aligns flexible content by block identity before applying translations', async () => {
    const baseDoc = {
      id: '3',
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
          id: '3',
          layout: [
            {
              _id: 'feature-1',
              blockType: 'feature',
              title: 'Key features',
            },
            {
              _id: 'hero-1',
              blockType: 'hero',
              title: 'Primary heading',
            },
          ],
        }
      }),
      logger: {
        error: vi.fn(),
        info: vi.fn(),
      },
      update: vi.fn<Payload['update']>(async (args) => args),
    } satisfies Partial<Payload>

    translateTextsMock.mockResolvedValueOnce(['Primaire heading', 'Belangrijkste functies'])

    const request: TranslateRequestPayload = {
      id: '3',
      collection: 'pages',
      from: 'en',
      locales: [
        {
          chunks: [
            [
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
          ],
          code: 'nl',
        },
      ],
    }

    for await (const _event of streamTranslations(payloadMock as Payload, request)) {
      // drain iterator
    }

    expect(payloadMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          layout: [
            {
              _id: 'hero-1',
              blockType: 'hero',
              title: 'Primaire heading',
            },
            {
              _id: 'feature-1',
              blockType: 'feature',
              title: 'Belangrijkste functies',
            },
          ],
        }),
        id: '3',
        locale: 'nl',
      }),
    )
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
      findByID: vi.fn<Payload['findByID']>().mockImplementation(async ({ locale }) => {
        if (locale === 'en') {
          return baseDoc
        }

        return { id: '1', settings: {} }
      }),
      logger: {
        error: vi.fn(),
        info: vi.fn(),
      },
      update: vi.fn<Payload['update']>(async (args) => args),
    } satisfies Partial<Payload>

    translateTextsMock.mockResolvedValueOnce(['Hallo daar', 'Welkom bezoeker'])

    const request: TranslateRequestPayload = {
      id: '1',
      collection: 'pages',
      from: 'en',
      locales: [
        {
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
          code: 'nl',
        },
      ],
    }

    const events: unknown[] = []
    for await (const event of streamTranslations(payloadMock as Payload, request)) {
      events.push(event)
    }

    expect(translateTextsMock).toHaveBeenCalledWith(['Greetings', 'Welcome visitor'], 'en', 'nl')

    expect(payloadMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          settings: {
            hero: {
              headline: 'Hallo daar',
              nested: {
                description: 'Welkom bezoeker',
              },
            },
          },
        }),
      }),
    )

    expect(events).toEqual([
      { type: 'progress', completed: 2, locale: 'nl', total: 2 },
      { type: 'applied', locale: 'nl' },
      { type: 'done' },
    ])
  })

  it('falls back to per-item translations when chunk translation fails', async () => {
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
      findByID: vi.fn<Payload['findByID']>().mockImplementation(async ({ locale }) => {
        if (locale === 'en') {
          return baseDoc
        }

        return { id: '1', settings: {} }
      }),
      logger: {
        error: vi.fn(),
        info: vi.fn(),
      },
      update: vi.fn<Payload['update']>(async (args) => args),
    } satisfies Partial<Payload>

    translateTextsMock
      .mockRejectedValueOnce(new Error('Chunk failure'))
      .mockResolvedValueOnce(['Hallo daar'])
      .mockResolvedValueOnce(['Welkom bezoeker'])

    const request: TranslateRequestPayload = {
      id: '1',
      collection: 'pages',
      from: 'en',
      locales: [
        {
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
          code: 'nl',
        },
      ],
    }

    const events: unknown[] = []
    for await (const event of streamTranslations(payloadMock as Payload, request)) {
      events.push(event)
    }

    expect(translateTextsMock).toHaveBeenCalledTimes(3)
    expect(translateTextsMock).toHaveBeenNthCalledWith(1, ['Greetings', 'Welcome visitor'], 'en', 'nl')
    expect(translateTextsMock).toHaveBeenNthCalledWith(2, ['Greetings'], 'en', 'nl')
    expect(translateTextsMock).toHaveBeenNthCalledWith(3, ['Welcome visitor'], 'en', 'nl')

    expect(payloadMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          settings: {
            hero: {
              headline: 'Hallo daar',
              nested: {
                description: 'Welkom bezoeker',
              },
            },
          },
        }),
        locale: 'nl',
      }),
    )

    expect(events).toEqual([
      { type: 'progress', completed: 2, locale: 'nl', total: 2 },
      { type: 'applied', locale: 'nl' },
      { type: 'done' },
    ])
  })

  it('surfaces an error if per-item fallback also fails', async () => {
    const baseDoc = {
      id: '1',
      settings: {
        hero: {
          headline: 'Greetings',
          nested: { description: 'Welcome visitor' },
        },
      },
    }

    const payloadMock = {
      findByID: vi.fn<Payload['findByID']>().mockResolvedValue(baseDoc),
      logger: {
        error: vi.fn(),
        info: vi.fn(),
      },
      update: vi.fn<Payload['update']>(async (args) => args),
    } satisfies Partial<Payload>

    translateTextsMock
      .mockRejectedValueOnce(new Error('Chunk failure'))
      .mockRejectedValueOnce(new Error('Single failure'))

    const request: TranslateRequestPayload = {
      id: '1',
      collection: 'pages',
      from: 'en',
      locales: [
        {
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
          code: 'nl',
        },
      ],
    }

    const events: unknown[] = []
    for await (const event of streamTranslations(payloadMock as Payload, request)) {
      events.push(event)
    }

    expect(translateTextsMock).toHaveBeenCalledTimes(2)
    expect(translateTextsMock).toHaveBeenNthCalledWith(1, ['Greetings', 'Welcome visitor'], 'en', 'nl')
    expect(translateTextsMock).toHaveBeenNthCalledWith(2, ['Greetings'], 'en', 'nl')

    expect(events).toEqual([{ type: 'error', message: 'Single failure' }])

    expect(payloadMock.logger?.error).toHaveBeenCalledWith(
      '[AI Translate] OpenAI translation failed for pages#1 (nl): Single failure',
    )
  })

  it('translates deeply nested blocks without dropping values', async () => {
    const baseDoc = {
      id: '1',
      layout: [
        {
          blockType: 'accordion',
          items: [
            {
              title: 'Top level heading',
              nestedBlocks: [
                {
                  blockType: 'callToAction',
                  label: 'Call to action',
                  stats: [
                    {
                      blockType: 'stat',
                      description: 'Nested statistic description',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }

    const payloadMock = {
      findByID: vi.fn<Payload['findByID']>().mockImplementation(async ({ locale }) => {
        if (locale === 'en') {
          return baseDoc
        }

        return { id: '1' }
      }),
      logger: {
        error: vi.fn(),
        info: vi.fn(),
      },
      update: vi.fn<Payload['update']>(async (args) => args),
    } satisfies Partial<Payload>

    translateTextsMock.mockResolvedValueOnce([
      'Bovenste kop',
      'Oproep tot actie',
      'Geneste statistiekbeschrijving',
    ])

    const request: TranslateRequestPayload = {
      id: '1',
      collection: 'pages',
      from: 'en',
      locales: [
        {
          chunks: [
            [
              {
                lexical: false,
                path: 'layout.0.items.0.title',
                text: 'Top level heading',
              },
              {
                lexical: false,
                path: 'layout.0.items.0.nestedBlocks.0.label',
                text: 'Call to action',
              },
              {
                lexical: false,
                path: 'layout.0.items.0.nestedBlocks.0.stats.0.description',
                text: 'Nested statistic description',
              },
            ],
          ],
          code: 'nl',
        },
      ],
    }

    const events: unknown[] = []
    for await (const event of streamTranslations(payloadMock as Payload, request)) {
      events.push(event)
    }

    expect(translateTextsMock).toHaveBeenCalledWith(
      ['Top level heading', 'Call to action', 'Nested statistic description'],
      'en',
      'nl',
    )

    expect(payloadMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          layout: [
            {
              blockType: 'accordion',
              items: [
                {
                  title: 'Bovenste kop',
                  nestedBlocks: [
                    {
                      blockType: 'callToAction',
                      label: 'Oproep tot actie',
                      stats: [
                        {
                          blockType: 'stat',
                          description: 'Geneste statistiekbeschrijving',
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      }),
    )

    expect(events).toEqual([
      { type: 'progress', completed: 3, locale: 'nl', total: 3 },
      { type: 'applied', locale: 'nl' },
      { type: 'done' },
    ])
  })

  it('emits an error event when translator output length mismatches the chunk', async () => {
    const baseDoc = {
      id: '1',
      title: 'Hello world',
    }

    const payloadMock = {
      findByID: vi.fn<Payload['findByID']>().mockImplementation(async ({ locale }) => {
        if (locale === 'en') {
          return baseDoc
        }

        return { id: '1' }
      }),
      logger: {
        error: vi.fn(),
        info: vi.fn(),
      },
      update: vi.fn<Payload['update']>(async (args) => args),
    } satisfies Partial<Payload>

    translateTextsMock.mockResolvedValueOnce([])

    const request: TranslateRequestPayload = {
      id: '1',
      collection: 'pages',
      from: 'en',
      locales: [
        {
          chunks: [
            [
              {
                lexical: false,
                path: 'title',
                text: 'Hello world',
              },
            ],
          ],
          code: 'nl',
        },
      ],
    }

    const events: unknown[] = []
    for await (const event of streamTranslations(payloadMock as Payload, request)) {
      events.push(event)
    }

    expect(events).toEqual([
      {
        type: 'error',
        message: 'Translator mismatch: expected 1, received 0',
      },
    ])
    expect(payloadMock.update).not.toHaveBeenCalled()
    expect(payloadMock.logger?.error).toHaveBeenCalledWith(
      '[AI Translate] Translation mismatch for pages#1 (nl).',
    )
  })

  it('translates lexical rich text fields while preserving structure', async () => {
    const baseDoc = structuredClone(tabbedBlockDocument)
    const lexicalValue = baseDoc.components[1]?.tab2?.fieldInTab2
    const serialized = serializeLexicalValue(lexicalValue)
    expect(serialized).not.toBeNull()

    const segments = splitLexicalText(serialized!.text, MAX_CHARS_PER_CHUNK)
    expect(segments.length).toBeGreaterThan(1)

    const replacePlaceholders = (input: string) =>
      input.replace(
        /\[\[LEX-(\d+)\]\]([\s\S]*?)\[\[\/LEX-\1\]\]/g,
        (_match, index) => `[[LEX-${index}]]Vertaling ${index}[[/LEX-${index}]]`,
      )

    const translatedSegments = segments.map((segment) => replacePlaceholders(segment))
    const translation = replacePlaceholders(serialized!.text)

    const payloadMock = {
      findByID: vi.fn<Payload['findByID']>().mockImplementation(async ({ locale }) => {
        if (locale === 'en') {
          return baseDoc
        }

        return { id: baseDoc.id }
      }),
      logger: {
        error: vi.fn(),
        info: vi.fn(),
      },
      update: vi.fn<Payload['update']>(async (args) => args),
    } satisfies Partial<Payload>

    let callIndex = 0
    translateTextsMock.mockImplementation(async (inputs) => {
      expect(inputs).toHaveLength(1)
      const segment = inputs[0]
      expect(segment).toBe(segments[callIndex])
      const output = translatedSegments[callIndex]
      callIndex += 1
      return [output]
    })

    const request: TranslateRequestPayload = {
      id: baseDoc.id,
      collection: 'posts',
      from: 'en',
      locales: [
        {
          chunks: [
            [
              {
                lexical: true,
                path: 'components.1.tab2.fieldInTab2',
                text: serialized!.text,
              },
            ],
          ],
          code: 'nl',
        },
      ],
    }

    const events: unknown[] = []
    for await (const event of streamTranslations(payloadMock as Payload, request)) {
      events.push(event)
    }

    expect(events).toContainEqual({ type: 'applied', locale: 'nl' })
    expect(events).toContainEqual({ type: 'done' })
    expect(payloadMock.update).toHaveBeenCalledTimes(1)
    expect(callIndex).toBe(segments.length)

    const saved = payloadMock.update.mock.calls[0][0]
    const savedValue = serializeLexicalValue(
      saved.data?.components?.[1]?.tab2?.fieldInTab2,
    )
    expect(savedValue?.text).toEqual(translation)
  })
})
