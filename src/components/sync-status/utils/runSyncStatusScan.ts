import type { SyncStatusScanEvent } from '../../../server/syncStatusTypes.js'

export async function runSyncStatusScan(
  targets: { collections: string[]; globals: string[] },
  onEvent: (event: SyncStatusScanEvent) => void,
): Promise<void> {
  const response = await fetch('/api/ai-sync-status/scan', {
    body: JSON.stringify(targets),
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.message || 'Sync status scan failed.')
  }
  if (!response.body) {
    throw new Error('The server did not return sync status data.')
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
          const event = JSON.parse(line) as SyncStatusScanEvent
          onEvent(event)
          if (event.type === 'scan-complete' || event.type === 'error') {
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
