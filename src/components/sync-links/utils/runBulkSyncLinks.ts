import type { BulkLinkSyncResponse } from '../../../server/linkSyncTypes.js'

export async function runBulkSyncLinks(
  collections: string[],
  options: {
    /**
     * Optional per-collection document filter; when set, only these documents
     * are link-synced.
     */
    documents?: Record<string, Array<number | string>>
    globals?: string[]
  } = {},
): Promise<BulkLinkSyncResponse> {
  const response = await fetch('/api/ai-links/bulk', {
    body: JSON.stringify({
      collections,
      documents: options.documents,
      globals: options.globals,
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })

  const json = await response.json().catch(() => ({}))

  if (!response.ok || json?.type !== 'success') {
    const message = typeof json?.message === 'string' ? json.message : 'Bulk link sync failed.'
    throw new Error(message)
  }

  const payload = json?.data as BulkLinkSyncResponse | undefined
  if (!payload) {
    throw new Error('Received an invalid server response.')
  }

  return payload
}
