import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TranslateRequestPayload } from '../../src/server/translationTypes.js'

import { openAiTranslateTexts } from '../../src/server/openAiTranslationClient.js'
import { streamTranslations } from '../../src/server/translationStream.js'

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

  it('removes nested metadata fields before saving complex product translations', async () => {
    const baseDoc = {
      id: 118,
      slug: '/en/products/left-b',
      title: 'LEFT B EARRINGS',
      image: 460,
      images: [460, 461, 462, 463],
      heading: 'LEFT B',
      editUrl: 'https://tweek-eek.myshopify.com/admin/products/6897821155487',
      _status: 'published',
      slugLock: true,
      material: 3,
      shopifyId: '6897821155487',
      updatedAt: '2025-10-12T16:54:01.527Z',
      createdAt: '2025-10-04T16:38:04.358Z',
      categories: [2, 30, 11],
      meta: {
        title: 'Left B — Earrings — 24K Gold-Plated Brass — Tweek-Eek',
        image: 460,
        noFollow: null,
        description:
          'Left B — Tweek-Eek. From the No Leftovers Collection, crafted from one plate to avoid waste. 24K gold-plated brass, 3-micron plating in the Netherlands.',
      },
      description:
        'Introducing THE NO LEFTOVERS COLLECTION. The idea of this collection is using everything from one plate ensuring that there is no leftover waste.',
      hover_image: 464,
      singularSlug: 'left-b',
      accordions: [
        {
          id: '68e14d6c4eeba23e6e714a98',
          heading: 'Description',
          content: {
            root: {
              type: 'root',
              format: '',
              indent: 0,
              version: 1,
              children: [
                {
                  type: 'paragraph',
                  format: '',
                  indent: 0,
                  version: 1,
                  children: [
                    {
                      mode: 'normal',
                      text: 'Introducing THE NO LEFTOVERS COLLECTION. The idea of this collection is using everything from one plate ensuring that there is no leftover waste.',
                      type: 'text',
                      style: '',
                      detail: 0,
                      format: 0,
                      version: 1,
                    },
                  ],
                  direction: null,
                },
                {
                  type: 'paragraph',
                  format: '',
                  indent: 0,
                  version: 1,
                  children: [
                    {
                      mode: 'normal',
                      text: 'The inspiration for this collection emerged when Roos was experimenting with a skeleton plate from a metal furniture factory. By cutting the plate into pieces, she discovered that new patterns emerged with unique shapes. For THE NO LEFTOVERS COLLECTION we designed pieces of jewelry where we use all the parts, including the leftover skeleton.',
                      type: 'text',
                      style: '',
                      detail: 0,
                      format: 0,
                      version: 1,
                    },
                  ],
                  direction: null,
                },
                {
                  type: 'paragraph',
                  format: '',
                  indent: 0,
                  version: 1,
                  children: [
                    {
                      mode: 'normal',
                      text: 'The refined design in combination with the use of the punching machine and pop rivets gives the collection a rough yet elegant look.',
                      type: 'text',
                      style: '',
                      detail: 0,
                      format: 0,
                      version: 1,
                    },
                  ],
                  direction: null,
                },
              ],
              direction: null,
            },
          },
        },
        {
          id: '68e14d6c4eeba23e6e714a99',
          heading: 'Details ',
          content: {
            root: {
              type: 'root',
              format: '',
              indent: 0,
              version: 1,
              children: [
                {
                  type: 'paragraph',
                  format: '',
                  indent: 0,
                  version: 1,
                  children: [
                    {
                      mode: 'normal',
                      text: 'Material: 3 micron 24K plated, base reused brass\nEar stud parts: 24K plated, base 925 sterling silver\nDimensions: (l x w x h) 20 mm x 13 mm x 1 mm\nWarranty: 1 year\nWeight: by pair 4,4 grams',
                      type: 'text',
                      style: '',
                      detail: 0,
                      format: 0,
                      version: 1,
                    },
                  ],
                  direction: null,
                },
              ],
              direction: null,
            },
          },
        },
      ],
      small_description: null,
      materialRelationships: [],
    }

    const payloadMock = {
      findByID: vi.fn<Payload['findByID']>().mockImplementation(async ({ locale }) => {
        if (locale === 'en') {
          return baseDoc
        }

        throw new Error('Not found')
      }),
      logger: {
        error: vi.fn(),
        info: vi.fn(),
      },
      update: vi.fn<Payload['update']>(async (args) => args),
    } satisfies Partial<Payload>

    translateTextsMock.mockResolvedValueOnce([
      'LEFT B OORBELLEN',
      '/nl/products/left-b',
      'left-b',
      'LEFT B',
      'Introductie VAN DE GEEN RESTJES COLLECTIE.',
      'Left B — Oorbellen — 24K Goudverguld Messing — Tweek-Eek',
      'Left B — Tweek-Eek. Uit de Geen Restjes Collectie, vervaardigd uit één plaat om afval te voorkomen. 24K goudverguld messing, 3-micron plating in Nederland.',
    ])

    const request: TranslateRequestPayload = {
      id: 118,
      collection: 'products',
      from: 'en',
      locales: [
        {
          chunks: [
            [
              { lexical: false, path: 'title', text: 'LEFT B EARRINGS' },
              { lexical: false, path: 'slug', text: '/en/products/left-b' },
              { lexical: false, path: 'singularSlug', text: 'left-b' },
              { lexical: false, path: 'heading', text: 'LEFT B' },
              {
                lexical: false,
                path: 'description',
                text: 'Introducing THE NO LEFTOVERS COLLECTION. The idea of this collection is using everything from one plate ensuring that there is no leftover waste.',
              },
              {
                lexical: false,
                path: 'meta.title',
                text: 'Left B — Earrings — 24K Gold-Plated Brass — Tweek-Eek',
              },
              {
                lexical: false,
                path: 'meta.description',
                text: 'Left B — Tweek-Eek. From the No Leftovers Collection, crafted from one plate to avoid waste. 24K gold-plated brass, 3-micron plating in the Netherlands.',
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

    expect(events.at(-1)).toEqual({ type: 'done' })
    expect(payloadMock.update).toHaveBeenCalledTimes(1)

    const updateArgs = vi.mocked(payloadMock.update).mock.calls[0]?.[0]
    expect(updateArgs).toBeDefined()

    const data = updateArgs?.data as Record<string, unknown>
    expect(data).toBeDefined()
    expect(data?.title).toBe('LEFT B OORBELLEN')
    expect(data?.shopifyId).toBe('6897821155487')

    const accordions = data?.accordions as Array<Record<string, unknown>>
    expect(Array.isArray(accordions)).toBe(true)
    accordions?.forEach((accordion) => {
      expect(accordion).not.toHaveProperty('id')
      expect(accordion).not.toHaveProperty('_id')
    })

    const serialized = JSON.stringify(data)
    expect(serialized).not.toContain('"id":')
    expect(serialized).not.toContain('"_id":')
    expect(serialized).not.toContain('"createdAt":')
    expect(serialized).not.toContain('"updatedAt":')
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
})
