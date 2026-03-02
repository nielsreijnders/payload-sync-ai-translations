import type {
  BulkGrammarApplyTarget,
  BulkStreamEvent,
} from '../../../server/translationTypes.js'

export type BulkGrammarCheckCallbacks = {
  onEvent(event: BulkStreamEvent): void
}

export async function runBulkGrammarCheck(
  targets: { collections: string[]; globals: string[] },
  options: { apply: boolean; applyTargets?: BulkGrammarApplyTarget[] },
  callbacks: BulkGrammarCheckCallbacks,
): Promise<void> {
  const response = await fetch('/api/ai-grammar/bulk', {
    body: JSON.stringify({
      apply: options.apply,
      applyTargets: options.applyTargets,
      collections: targets.collections,
      globals: targets.globals,
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || 'Grammar check request failed.')
  }

  if (!response.body) {
    throw new Error('The server did not return any data.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let stop = false

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
        try {
          const event = JSON.parse(line) as BulkStreamEvent
          callbacks.onEvent(event)
          if (event.type === 'bulk-complete' || event.type === 'error') {
            stop = true
            break
          }
        } catch {
          // ignore invalid JSON lines
        }
      }

      newlineIndex = buffer.indexOf('\n')
    }
  }
}
