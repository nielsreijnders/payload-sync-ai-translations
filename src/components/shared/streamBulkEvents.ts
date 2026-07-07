import type { BulkStreamEvent } from '../../server/translationTypes.js'

/**
 * POSTs a JSON body to a plugin endpoint that answers with an NDJSON stream
 * of BulkStreamEvent lines, invoking `onEvent` per parsed event until the
 * stream completes or reports an error.
 */
export async function postBulkStream(
  url: string,
  body: unknown,
  onEvent: (event: BulkStreamEvent) => void,
  errorMessage: string,
): Promise<void> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || errorMessage)
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
          onEvent(event)
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
