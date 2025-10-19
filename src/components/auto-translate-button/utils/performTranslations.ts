import type { TranslateStreamEvent } from '../../../server/types.js'
import type { TranslatableItem } from './buildTranslatableItems.js'

export type LocaleTranslationPlan = {
  chunks: TranslatableItem[][]
  code: string
  overrides?: TranslatableItem[]
}

export type TranslationRequest = {
  collection: string
  defaultLocale: string
  id: string
  locales: LocaleTranslationPlan[]
}

export type TranslationCallbacks = {
  onApplied(locale: string): void
  onDone(): void
  onError(message: string): void
  onMissingBody(): void
  onProgress(event: { completed: number; locale: string; total: number }): void
  onStart(): void
  onUnexpectedResponse(status: number, statusText: string, bodyText: string): void
}

export async function performTranslations(
  request: TranslationRequest,
  callbacks: TranslationCallbacks,
): Promise<{ finished: boolean; hadError: boolean }> {
  callbacks.onStart()

  const response = await fetch('/api/ai-translate', {
    body: JSON.stringify({
      id: request.id,
      collection: request.collection,
      from: request.defaultLocale,
      locales: request.locales.map((locale) => ({
        chunks: locale.chunks,
        code: locale.code,
        overrides: locale.overrides,
      })),
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    callbacks.onUnexpectedResponse(response.status, response.statusText, text)
    return { finished: false, hadError: true }
  }

  if (!response.body) {
    callbacks.onMissingBody()
    return { finished: false, hadError: true }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let stop = false
  let finished = false
  let hadError = false

  while (!stop) {
    const { done, value } = await reader.read()

    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })

    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)

      if (line) {
        let parsed: null | TranslateStreamEvent = null

        try {
          parsed = JSON.parse(line) as TranslateStreamEvent
        } catch {
          parsed = null
        }

        if (parsed) {
          switch (parsed.type) {
            case 'applied':
              callbacks.onApplied(parsed.locale)
              break
            case 'done':
              callbacks.onDone()
              finished = true
              stop = true
              break
            case 'error':
              callbacks.onError(parsed.message || 'Translation failed.')
              hadError = true
              stop = true
              break
            case 'progress':
              callbacks.onProgress({
                completed: parsed.completed,
                locale: parsed.locale,
                total: parsed.total,
              })
              break
            default:
              break
          }
        }
      }

      newlineIndex = buffer.indexOf('\n')
    }
  }

  return { finished, hadError }
}
