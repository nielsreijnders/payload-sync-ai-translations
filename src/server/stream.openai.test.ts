import type { Payload } from 'payload'

import { describe, expect, it, vi } from 'vitest'

import type { TranslateRequestPayload } from './types.js'

import { streamTranslations } from './stream.js'

const describeIfApiKey = process.env.OPENAI_API_KEY ? describe : describe.skip

describeIfApiKey('streamTranslations (OpenAI live)', () => {
  it('translates a simple document by calling the real OpenAI API', async () => {
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

    expect(payloadMock.update).toHaveBeenCalledTimes(1)
    const updateArgs = payloadMock.update.mock.calls[0][0]
    const translatedTitle = (updateArgs.data as { title: string }).title

    expect(translatedTitle).toBe('Hallo wereld')
    expect(events).toContainEqual({
      type: 'applied',
      locale: 'nl',
    })
  }, 60_000)
})
