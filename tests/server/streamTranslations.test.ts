import type { Payload } from 'payload'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { streamTranslations } from '../../src/server/translationStream.js'

vi.mock('../../src/server/openAiTranslationClient.js', () => ({
  openAiTranslateTexts: vi.fn(async (texts: string[]) => texts.map((text) => `${text}-translated`)),
}))

describe('streamTranslations', () => {
  const payload = {
    findByID: vi.fn(),
    update: vi.fn(),
    logger: { info: vi.fn(), error: vi.fn() },
  } satisfies Partial<Payload> as Payload

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('preserves other blocks when translating a single field', async () => {
    payload.findByID = vi
      .fn()
      .mockImplementationOnce(async () => ({
        id: '1',
        blocks: [
          { id: 'a', blockType: 'hero', heading: 'Hello', description: 'World' },
          { id: 'b', blockType: 'cta', heading: 'Other', description: 'Value' },
        ],
      }))
      .mockImplementationOnce(async () => ({
        id: '1',
        blocks: [
          { id: 'a', blockType: 'hero', heading: 'Hallo', description: 'Wereld' },
          { id: 'b', blockType: 'cta', heading: 'Other', description: 'Value' },
        ],
      }))

    payload.update = vi.fn()

    const iterator = streamTranslations(payload, {
      collection: 'pages',
      from: 'en',
      id: '1',
      locales: [
        {
          code: 'nl',
          chunks: [
            [
              { lexical: false, path: 'blocks.1.description', text: 'Value' },
            ],
          ],
        },
      ],
    })

    for await (const event of iterator) {
      if (event.type === 'error') {
        throw new Error(event.message)
      }
    }

    expect(payload.findByID).toHaveBeenNthCalledWith(1, {
      id: '1',
      collection: 'pages',
      draft: true,
      depth: 0,
      fallbackLocale: false,
      locale: 'en',
    })

    expect(payload.findByID).toHaveBeenNthCalledWith(2, {
      id: '1',
      collection: 'pages',
      draft: true,
      depth: 0,
      fallbackLocale: false,
      locale: 'nl',
    })

    expect(payload.update).toHaveBeenCalledWith({
      id: '1',
      collection: 'pages',
      draft: true,
      data: expect.any(Object),
      locale: 'nl',
      overrideAccess: true,
    })

    const data = payload.update?.mock.calls[0]?.[0]?.data as any
    expect(Array.isArray(data.blocks)).toBe(true)
    expect(data.blocks).toHaveLength(2)
    expect(data.blocks[0]).toMatchObject({ blockType: 'hero', heading: 'Hallo' })
    expect(data.blocks[1]).toMatchObject({ blockType: 'cta', description: 'Value-translated' })
  })
})
