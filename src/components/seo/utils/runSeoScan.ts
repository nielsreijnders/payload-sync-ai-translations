import type { SeoScanEvent } from '../../../server/seoTypes.js'

export async function runSeoScan(
  collections: string[],
  locale: string,
  onEvent: (event: SeoScanEvent) => void,
): Promise<void> {
  const response = await fetch('/api/ai-seo/scan', {
    body: JSON.stringify({ collections, locale }),
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.message || 'SEO scan request failed.')
  }
  if (!response.body) {
    throw new Error('The server did not return SEO scan data.')
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
        const event = JSON.parse(line) as SeoScanEvent
        onEvent(event)
        if (event.type === 'scan-complete' || event.type === 'error') {
          stop = true
          break
        }
      }

      newlineIndex = buffer.indexOf('\n')
    }
  }
}
