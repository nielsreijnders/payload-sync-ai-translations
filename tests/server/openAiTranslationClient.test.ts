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

  it('throws an error when OpenAI response has a mismatched length', async () => {
    completionsCreateMock.mockResolvedValue({
      id: 'resp-2',
      created: 0,
      usage: {},
      choices: [
        {
          message: {
            content: JSON.stringify({ t: ['Eén', 'Twee'] }),
          },
        },
      ],
    })

    await expect(openAiTranslateTexts(['One'], 'en', 'nl')).rejects.toThrow(
      'Invalid translation response from OpenAI: expected 1 entries, received 2.',
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
