import { beforeEach, describe, expect, it, vi } from 'vitest'

import { openAiTranslateTexts } from '../../src/server/openAiTranslationClient.js'
import { setOpenAISettings } from '../../src/server/openAiSettings.js'

const completionsCreateMock = vi.fn()

vi.mock('openai', () => ({
  default: class {
    chat = {
      completions: {
        create: completionsCreateMock,
      },
    }

    constructor(_options: { apiKey: string }) {}
  },
}))

describe('openAiTranslateTexts', () => {
  beforeEach(() => {
    completionsCreateMock.mockReset()
    setOpenAISettings({ apiKey: 'test-key', model: 'test-model' })
  })

  it('returns translated strings when OpenAI provides a matching response', async () => {
    completionsCreateMock.mockResolvedValue({
      id: 'resp-1',
      created: 0,
      usage: {},
      choices: [
        {
          message: {
            content: JSON.stringify({ t: ['Hallo wereld'] }),
          },
        },
      ],
    })

    const result = await openAiTranslateTexts(['Hello world'], 'en', 'nl')
    expect(result).toEqual(['Hallo wereld'])
  })

  it('requests a strict JSON schema that stays identical across batch sizes', async () => {
    completionsCreateMock.mockResolvedValue({
      id: 'resp-1b',
      created: 0,
      usage: {},
      choices: [
        {
          message: {
            content: JSON.stringify({ t: ['Hallo', 'Wereld'] }),
          },
        },
      ],
    })

    await openAiTranslateTexts(['Hello', 'World'], 'en', 'nl')

    // The schema must not vary with the number of inputs: a changing schema
    // invalidates OpenAI's automatic prompt caching on every request.
    expect(completionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'ai_translation_response',
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['t'],
              properties: {
                t: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
            },
          },
        },
      }),
    )
  })

  it('keeps the custom prompt in the stable prefix, before locales and items', async () => {
    completionsCreateMock.mockResolvedValue({
      id: 'resp-1c',
      created: 0,
      usage: {},
      choices: [
        {
          message: {
            content: JSON.stringify({ t: ['Hallo'] }),
          },
        },
      ],
    })

    await openAiTranslateTexts(['Hello'], 'en', 'nl', { customPrompt: 'Use formal tone.' })

    const params = completionsCreateMock.mock.calls[0][0]
    const userMessage = params.messages.find(
      (message: { role: string }) => message.role === 'user',
    ) as { content: string }

    const promptIndex = userMessage.content.indexOf('Custom instructions: Use formal tone.')
    const localeIndex = userMessage.content.indexOf('Source locale: "en". Target locale: "nl".')
    const itemsIndex = userMessage.content.indexOf('items (1 entries):')

    expect(promptIndex).toBeGreaterThan(-1)
    expect(localeIndex).toBeGreaterThan(promptIndex)
    expect(itemsIndex).toBeGreaterThan(localeIndex)
  })

  it('uses the model override from options when provided', async () => {
    completionsCreateMock.mockResolvedValue({
      id: 'resp-1d',
      created: 0,
      usage: {},
      choices: [
        {
          message: {
            content: JSON.stringify({ t: ['Hallo'] }),
          },
        },
      ],
    })

    await openAiTranslateTexts(['Hello'], 'en', 'nl', { model: 'override-model' })

    expect(completionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'override-model' }),
    )
  })

  it('retries without temperature when the model rejects it', async () => {
    setOpenAISettings({ apiKey: 'test-key', model: 'reasoning-model' })

    completionsCreateMock
      .mockRejectedValueOnce({
        code: 'unsupported_value',
        message:
          "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.",
        param: 'temperature',
      })
      .mockResolvedValue({
        id: 'resp-1e',
        created: 0,
        usage: {},
        choices: [
          {
            message: {
              content: JSON.stringify({ t: ['Hallo'] }),
            },
          },
        ],
      })

    const result = await openAiTranslateTexts(['Hello'], 'en', 'nl')

    expect(result).toEqual(['Hallo'])
    expect(completionsCreateMock).toHaveBeenCalledTimes(2)
    expect(completionsCreateMock.mock.calls[0][0]).toHaveProperty('temperature', 0)
    expect(completionsCreateMock.mock.calls[1][0]).not.toHaveProperty('temperature')

    // The rejection is remembered per model: later calls skip temperature entirely.
    await openAiTranslateTexts(['World'], 'en', 'nl')
    expect(completionsCreateMock).toHaveBeenCalledTimes(3)
    expect(completionsCreateMock.mock.calls[2][0]).not.toHaveProperty('temperature')
  })

  it('throws an error when OpenAI response has a mismatched length', async () => {
    completionsCreateMock.mockResolvedValue({
      id: 'resp-2',
      created: 0,
      usage: {},
      choices: [
        {
          message: {
            content: JSON.stringify({ t: ['Geïnspireerd door', 'het lichaam.'] }),
          },
        },
      ],
    })

    await expect(
      openAiTranslateTexts(['Inspired by form\naround the body.'], 'en', 'nl'),
    ).rejects.toThrow('Invalid translation response from OpenAI: expected 1 entries, received 2.')
  })

  it('throws an error when OpenAI response omits required entries', async () => {
    completionsCreateMock.mockResolvedValue({
      id: 'resp-2b',
      created: 0,
      usage: {},
      choices: [
        {
          message: {
            content: JSON.stringify({ t: ['Eén'] }),
          },
        },
      ],
    })

    await expect(openAiTranslateTexts(['One', 'Two'], 'en', 'nl')).rejects.toThrow(
      'Invalid translation response from OpenAI: expected 2 entries, received 1.',
    )
  })

  it('throws an error when OpenAI response is not valid JSON', async () => {
    completionsCreateMock.mockResolvedValue({
      id: 'resp-3',
      created: 0,
      usage: {},
      choices: [
        {
          message: {
            content: 'not json',
          },
        },
      ],
    })

    await expect(openAiTranslateTexts(['One'], 'en', 'nl')).rejects.toThrow(
      'Invalid translation response from OpenAI: unable to parse JSON payload.',
    )
  })

  it('repairs a response missing a closing array bracket', async () => {
    completionsCreateMock.mockResolvedValue({
      id: 'resp-3b',
      created: 0,
      usage: {},
      choices: [
        {
          message: {
            content: '{"t": ["Hallo wereld"}',
          },
        },
      ],
    })

    const result = await openAiTranslateTexts(['Hello world'], 'en', 'nl')
    expect(result).toEqual(['Hallo wereld'])
  })

  it('preserves slug-like values when OpenAI attempts to translate them', async () => {
    completionsCreateMock.mockResolvedValue({
      id: 'resp-4',
      created: 0,
      usage: {},
      choices: [
        {
          message: {
            content: JSON.stringify({ t: ['/nl/producten/example', 'Beschrijving'] }),
          },
        },
      ],
    })

    const result = await openAiTranslateTexts(['/en/products/example', 'Description'], 'en', 'nl')
    expect(result).toEqual(['/en/products/example', 'Beschrijving'])
  })

  it('throws when lexical markers are removed from the translation', async () => {
    completionsCreateMock.mockResolvedValue({
      id: 'resp-5',
      created: 0,
      usage: {},
      choices: [
        {
          message: {
            content: JSON.stringify({ t: ['Hallo wereld'] }),
          },
        },
      ],
    })

    await expect(
      openAiTranslateTexts(['[[LEX-0]]Hello world[[/LEX-0]]'], 'en', 'nl'),
    ).rejects.toThrow(
      'Invalid translation response from OpenAI: lexical markers were modified or removed.',
    )
  })
})
