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

  it('applies translations for a complex product document copied from the debug helper', async () => {
    const baseDoc = {
      id: '165',
      title: 'MIRR WAVE MESSING NECKLACE',
      slug: '/en/products/mirr-wave-messing-3',
      singularSlug: 'mirr-wave-messing-3',
      heading: 'mirr wave',
      description:
        'Discover a world where rigid metal transforms into fluid forms.\nA bold exploration of material and machine,\nwhere imagination and the unexpected take shape.',
      accordions: [
        {
          id: '68f778983e22267c983b633b',
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
                  format: 'start',
                  indent: 0,
                  version: 1,
                  children: [
                    {
                      mode: 'normal',
                      text: 'Discover a world where rigid metal transforms into fluid forms. A bold exploration of material and machine,where imagination and the unexpected take shape.',
                      type: 'text',
                      style: '',
                      detail: 0,
                      format: 0,
                      version: 1,
                    },
                  ],
                  direction: 'ltr',
                  textStyle: '',
                  textFormat: 0,
                },
                {
                  type: 'paragraph',
                  format: 'start',
                  indent: 0,
                  version: 1,
                  children: [
                    {
                      mode: 'normal',
                      text: 'Fabric is gentle, stretchable, and easy to shape, the very opposite of metal. That was the core of our challenge for the new collection: how can we give metal that same sense of apparent flexibility? Through twisting, bending, and pressing, we transformed metal into organic, almost fluid forms.',
                      type: 'text',
                      style: '',
                      detail: 0,
                      format: 0,
                      version: 1,
                    },
                  ],
                  direction: 'ltr',
                  textStyle: '',
                  textFormat: 0,
                },
                {
                  type: 'paragraph',
                  format: 'start',
                  indent: 0,
                  version: 1,
                  children: [
                    {
                      mode: 'normal',
                      text: 'The goal? The unexpected: to show that flexibility does not always belong to soft materials.',
                      type: 'text',
                      style: '',
                      detail: 0,
                      format: 0,
                      version: 1,
                    },
                  ],
                  direction: 'ltr',
                  textStyle: '',
                  textFormat: 0,
                },
                {
                  type: 'paragraph',
                  format: 'start',
                  indent: 0,
                  version: 1,
                  children: [
                    {
                      mode: 'normal',
                      text: 'The limits of machines and materials push us to experiment, to search for solutions, and to discover new, unique forms. Although today almost anything seems possible, we choose to work with restrictions: hard metal and industrial machines full of “cannots.” Those very limitations become our source of inspiration.',
                      type: 'text',
                      style: '',
                      detail: 0,
                      format: 0,
                      version: 1,
                    },
                  ],
                  direction: 'ltr',
                  textStyle: '',
                  textFormat: 0,
                },
                {
                  type: 'paragraph',
                  format: 'start',
                  indent: 0,
                  version: 1,
                  children: [
                    {
                      mode: 'normal',
                      text: 'Over the years, we have learned to speak more and more through our hands. We challenge ourselves, combining craftsmanship with the raw force of our machines, resulting each time in surprising, new, experimental forms.',
                      type: 'text',
                      style: '',
                      detail: 0,
                      format: 0,
                      version: 1,
                    },
                  ],
                  direction: 'ltr',
                  textStyle: '',
                  textFormat: 0,
                },
              ],
              direction: 'ltr',
            },
          },
        },
        {
          id: '68f7789d3e22267c983b633c',
          heading: 'Details',
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
                      text: 'Material: Reused brass',
                      type: 'text',
                      style: '',
                      detail: 0,
                      format: 0,
                      version: 1,
                    },
                    { type: 'linebreak', version: 1 },
                    {
                      mode: 'normal',
                      text: 'Chain: 24K plated, base 925 sterling silver',
                      type: 'text',
                      style: '',
                      detail: 0,
                      format: 0,
                      version: 1,
                    },
                    { type: 'linebreak', version: 1 },
                    {
                      mode: 'normal',
                      text: 'Dimensions: (l x b x h) 64 mm x 5 mm x 5 mm',
                      type: 'text',
                      style: '',
                      detail: 0,
                      format: 0,
                      version: 1,
                    },
                    { type: 'linebreak', version: 1 },
                    {
                      mode: 'normal',
                      text: 'Warranty: 1 year',
                      type: 'text',
                      style: '',
                      detail: 0,
                      format: 0,
                      version: 1,
                    },
                    { type: 'linebreak', version: 1 },
                    {
                      mode: 'normal',
                      text: 'Weight: 2,9 gram',
                      type: 'text',
                      style: '',
                      detail: 0,
                      format: 0,
                      version: 1,
                    },
                  ],
                  direction: 'ltr',
                  textStyle: '',
                  textFormat: 0,
                },
              ],
              direction: 'ltr',
            },
          },
        },
        {
          id: '6900825c1c189f24e649ed7d',
          heading: 'Size guide',
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
                      text: 'Are you looking for a necklace, but having trouble finding the right length? We provide exact measurements for all of our necklaces.',
                      type: 'text',
                      style: '',
                      detail: 0,
                      format: 0,
                      version: 1,
                    },
                  ],
                  direction: null,
                  textStyle: '',
                  textFormat: 0,
                },
                {
                  type: 'paragraph',
                  format: '',
                  indent: 0,
                  version: 1,
                  children: [
                    {
                      mode: 'normal',
                      text: 'The size chart ',
                      type: 'text',
                      style: '',
                      detail: 0,
                      format: 0,
                      version: 1,
                    },
                    {
                      id: '690200dba59f5e6242e4c003',
                      type: 'link',
                      fields: {
                        url: 'https://www.tweek-eek.com/size-guide',
                        newTab: true,
                        linkType: 'custom',
                      },
                      format: '',
                      indent: 0,
                      version: 3,
                      children: [
                        {
                          mode: 'normal',
                          text: 'below',
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
                      mode: 'normal',
                      text: ' will help you find the perfect length for your necklace.',
                      type: 'text',
                      style: '',
                      detail: 0,
                      format: 0,
                      version: 1,
                    },
                  ],
                  direction: null,
                  textStyle: '',
                  textFormat: 0,
                },
              ],
              direction: 'ltr',
            },
          },
        },
      ],
    }

    const payloadMock = {
      findByID: vi.fn<Payload['findByID']>().mockImplementation(async ({ locale }) => {
        if (locale === 'en') {
          return baseDoc
        }

        return { id: '165' }
      }),
      logger: {
        error: vi.fn(),
        info: vi.fn(),
      },
      update: vi.fn<Payload['update']>(async (args) => args),
    } satisfies Partial<Payload>

    const chunk = [
      { lexical: false, path: 'title', text: 'MIRR WAVE MESSING NECKLACE' },
      { lexical: false, path: 'slug', text: '/en/products/mirr-wave-messing-3' },
      { lexical: false, path: 'singularSlug', text: 'mirr-wave-messing-3' },
      { lexical: false, path: 'heading', text: 'mirr wave' },
      {
        lexical: false,
        path: 'description',
        text: 'Discover a world where rigid metal transforms into fluid forms.\nA bold exploration of material and machine,\nwhere imagination and the unexpected take shape.',
      },
      { lexical: false, path: 'accordions.0.heading', text: 'Description' },
      { lexical: false, path: 'accordions.1.heading', text: 'Details' },
      { lexical: false, path: 'accordions.2.heading', text: 'Size guide' },
      {
        lexical: true,
        path: 'accordions.0.content',
        text: '[[LEX-0]]Discover a world where rigid metal transforms into fluid forms. A bold exploration of material and machine,where imagination and the unexpected take shape.[[/LEX-0]]\n\n[[LEX-1]]Fabric is gentle, stretchable, and easy to shape, the very opposite of metal. That was the core of our challenge for the new collection: how can we give metal that same sense of apparent flexibility? Through twisting, bending, and pressing, we transformed metal into organic, almost fluid forms.[[/LEX-1]]\n\n[[LEX-2]]The goal? The unexpected: to show that flexibility does not always belong to soft materials.[[/LEX-2]]\n\n[[LEX-3]]The limits of machines and materials push us to experiment, to search for solutions, and to discover new, unique forms. Although today almost anything seems possible, we choose to work with restrictions: hard metal and industrial machines full of “cannots.” Those very limitations become our source of inspiration.[[/LEX-3]]\n\n[[LEX-4]]Over the years, we have learned to speak more and more through our hands. We challenge ourselves, combining craftsmanship with the raw force of our machines, resulting each time in surprising, new, experimental forms.[[/LEX-4]]',
      },
      {
        lexical: true,
        path: 'accordions.1.content',
        text: '[[LEX-0]]Material: Reused brass[[/LEX-0]]\n[[LEX-1]]Chain: 24K plated, base 925 sterling silver[[/LEX-1]]\n[[LEX-2]]Dimensions: (l x b x h) 64 mm x 5 mm x 5 mm[[/LEX-2]]\n[[LEX-3]]Warranty: 1 year[[/LEX-3]]\n[[LEX-4]]Weight: 2,9 gram[[/LEX-4]]',
      },
      {
        lexical: true,
        path: 'accordions.2.content',
        text: '[[LEX-0]]Are you looking for a necklace, but having trouble finding the right length? We provide exact measurements for all of our necklaces.[[/LEX-0]]\n\n[[LEX-1]]The size chart [[/LEX-1]][[LEX-2]]below[[/LEX-2]][[LEX-3]] will help you find the perfect length for your necklace.[[/LEX-3]]',
      },
    ]

    translateTextsMock.mockResolvedValueOnce([
      'MIRR WAVE MESSING KETTING',
      '/nl/products/mirr-wave-messing-3',
      'mirr-wave-messing-3-nl',
      'mirr golf',
      'Ontdek een wereld waarin hard metaal verandert in vloeiende vormen.\nEen gedurfde verkenning van materiaal en machine,\nwaar verbeelding en het onverwachte vorm krijgen.',
      'Beschrijving',
      'Details (NL)',
      'Maattabel',
      '[[LEX-0]]Ontdek een wereld waarin hard metaal verandert in vloeiende vormen. Een gedurfde verkenning van materiaal en machine, waar verbeelding en het onverwachte vorm krijgen.[[/LEX-0]]\n\n[[LEX-1]]Stof is zacht, rekbaar en gemakkelijk te vormen, het tegenovergestelde van metaal. Dat was de kern van onze uitdaging voor de nieuwe collectie: hoe geven we metaal datzelfde gevoel van schijnbare flexibiliteit? Door te draaien, buigen en persen transformeerden we metaal in organische, bijna vloeibare vormen.[[/LEX-1]]\n\n[[LEX-2]]Het doel? Het onverwachte: laten zien dat flexibiliteit niet altijd tot zachte materialen behoort.[[/LEX-2]]\n\n[[LEX-3]]De grenzen van machines en materialen duwen ons om te experimenteren, op zoek te gaan naar oplossingen en nieuwe, unieke vormen te ontdekken. Hoewel tegenwoordig bijna alles mogelijk lijkt, kiezen we ervoor om met beperkingen te werken: hard metaal en industriële machines vol "kan niet". Juist die beperkingen worden onze inspiratiebron.[[/LEX-3]]\n\n[[LEX-4]]Door de jaren heen hebben we steeds meer leren spreken met onze handen. We dagen onszelf uit, combineren vakmanschap met de ruwe kracht van onze machines, wat telkens resulteert in verrassende, nieuwe, experimentele vormen.[[/LEX-4]]',
      '[[LEX-0]]Materiaal: Hergebruikt messing[[/LEX-0]]\n[[LEX-1]]Ketting: 24K verguld, basis 925 sterling zilver[[/LEX-1]]\n[[LEX-2]]Afmetingen: (l x b x h) 64 mm x 5 mm x 5 mm[[/LEX-2]]\n[[LEX-3]]Garantie: 1 jaar[[/LEX-3]]\n[[LEX-4]]Gewicht: 2,9 gram[[/LEX-4]]',
      '[[LEX-0]]Zoek je een ketting maar kun je de juiste lengte niet vinden? Wij geven exacte afmetingen voor al onze kettingen.[[/LEX-0]]\n\n[[LEX-1]]De maattabel [[/LEX-1]][[LEX-2]]hieronder[[/LEX-2]][[LEX-3]] helpt je om de perfecte lengte voor je ketting te vinden.[[/LEX-3]]',
    ])

    const request: TranslateRequestPayload = {
      id: '165',
      collection: 'products',
      from: 'en',
      locales: [
        {
          code: 'nl',
          chunks: [chunk],
        },
      ],
    }

    const events: unknown[] = []
    for await (const event of streamTranslations(payloadMock as Payload, request)) {
      events.push(event)
    }

    expect(translateTextsMock).toHaveBeenCalledWith(
      chunk.map((item) => item.text),
      'en',
      'nl',
    )

    const updateArgs = vi.mocked(payloadMock.update).mock.calls[0]?.[0]
    expect(updateArgs?.locale).toBe('nl')
    expect(updateArgs?.overrideAccess).toBe(true)

    const updatedData = updateArgs?.data as
      | undefined
      | {
          title?: string
          slug?: string
          singularSlug?: string
          heading?: string
          description?: string
          accordions?: Array<
            | undefined
            | {
                heading?: string
                content?: {
                  root?: {
                    children?: Array<
                      | undefined
                      | {
                          children?: Array<
                            | undefined
                            | { text?: string; children?: Array<{ text?: string }> }
                          >
                        }
                    >
                  }
                }
              }
          >
        }

    expect(updatedData?.title).toBe('MIRR WAVE MESSING KETTING')
    expect(updatedData?.slug).toBe('/nl/products/mirr-wave-messing-3')
    expect(updatedData?.singularSlug).toBe('mirr-wave-messing-3-nl')
    expect(updatedData?.heading).toBe('mirr golf')
    expect(updatedData?.description).toBe(
      'Ontdek een wereld waarin hard metaal verandert in vloeiende vormen.\nEen gedurfde verkenning van materiaal en machine,\nwaar verbeelding en het onverwachte vorm krijgen.',
    )

    const accordions = updatedData?.accordions ?? []
    expect(accordions[0]?.heading).toBe('Beschrijving')
    expect(
      accordions[0]?.content?.root?.children?.map((child) => child?.children?.[0]?.text ?? ''),
    ).toEqual([
      'Ontdek een wereld waarin hard metaal verandert in vloeiende vormen. Een gedurfde verkenning van materiaal en machine, waar verbeelding en het onverwachte vorm krijgen.',
      'Stof is zacht, rekbaar en gemakkelijk te vormen, het tegenovergestelde van metaal. Dat was de kern van onze uitdaging voor de nieuwe collectie: hoe geven we metaal datzelfde gevoel van schijnbare flexibiliteit? Door te draaien, buigen en persen transformeerden we metaal in organische, bijna vloeibare vormen.',
      'Het doel? Het onverwachte: laten zien dat flexibiliteit niet altijd tot zachte materialen behoort.',
      'De grenzen van machines en materialen duwen ons om te experimenteren, op zoek te gaan naar oplossingen en nieuwe, unieke vormen te ontdekken. Hoewel tegenwoordig bijna alles mogelijk lijkt, kiezen we ervoor om met beperkingen te werken: hard metaal en industriële machines vol "kan niet". Juist die beperkingen worden onze inspiratiebron.',
      'Door de jaren heen hebben we steeds meer leren spreken met onze handen. We dagen onszelf uit, combineren vakmanschap met de ruwe kracht van onze machines, wat telkens resulteert in verrassende, nieuwe, experimentele vormen.',
    ])

    expect(accordions[1]?.heading).toBe('Details (NL)')
    expect(
      accordions[1]?.content?.root?.children?.[0]?.children?.filter((node) => 'text' in (node ?? {})).map(
        (node) => (node as { text?: string }).text ?? '',
      ),
    ).toEqual([
      'Materiaal: Hergebruikt messing',
      'Ketting: 24K verguld, basis 925 sterling zilver',
      'Afmetingen: (l x b x h) 64 mm x 5 mm x 5 mm',
      'Garantie: 1 jaar',
      'Gewicht: 2,9 gram',
    ])

    expect(accordions[2]?.heading).toBe('Maattabel')
    const sizeGuideParagraphs = accordions[2]?.content?.root?.children ?? []
    expect(sizeGuideParagraphs[0]?.children?.[0]?.text).toBe(
      'Zoek je een ketting maar kun je de juiste lengte niet vinden? Wij geven exacte afmetingen voor al onze kettingen.',
    )
    expect(sizeGuideParagraphs[1]?.children?.[0]?.text).toBe('De maattabel ')
    expect(sizeGuideParagraphs[1]?.children?.[1]?.children?.[0]?.text).toBe('hieronder')
    expect(sizeGuideParagraphs[1]?.children?.[2]?.text).toBe(
      ' helpt je om de perfecte lengte voor je ketting te vinden.',
    )

    expect(events).toEqual([
      { type: 'progress', completed: chunk.length, locale: 'nl', total: chunk.length },
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
})
