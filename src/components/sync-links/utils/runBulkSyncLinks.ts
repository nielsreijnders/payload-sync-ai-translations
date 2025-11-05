import type { BulkLinkSyncResponse } from '../../../server/linkSyncTypes.js'

export async function runBulkSyncLinks(collections: string[]): Promise<BulkLinkSyncResponse> {
  const response = await fetch('/api/ai-links/bulk', {
    body: JSON.stringify({ collections }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })

  const json = await response.json().catch(() => ({}))

  if (!response.ok || json?.type !== 'success') {
    const message = typeof json?.message === 'string' ? json.message : 'Bulk synchronisatie mislukt.'
    throw new Error(message)
  }

  const payload = json?.data as BulkLinkSyncResponse | undefined
  if (!payload) {
    throw new Error('Ongeldige serverrespons ontvangen.')
  }

  return payload
}
