import type { LinkSyncResponsePayload } from '../../../server/translationTypes.js'
import type { TranslatableItem } from './buildTranslatableItems.js'

type LinkSyncPlanRequest = {
  collection: string
  defaultLocale: string
  id: number | string
  items: TranslatableItem[]
  locales: string[]
}

export async function requestLinkSyncPlan(
  request: LinkSyncPlanRequest,
): Promise<LinkSyncResponsePayload> {
  const response = await fetch('/api/ai-translate/links', {
    body: JSON.stringify({
      id: request.id,
      collection: request.collection,
      from: request.defaultLocale,
      items: request.items.map((item) => ({
        lexical: item.lexical,
        path: item.path,
        text: item.text,
      })),
      locales: request.locales,
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    const message = await response.text().catch(() => 'Link synchronization review failed.')
    throw new Error(message || 'Link synchronization review failed.')
  }

  const plan = (await response.json()) as LinkSyncResponsePayload
  if (!plan || !Array.isArray(plan.locales)) {
    throw new Error('Unexpected response from link synchronization review.')
  }

  return plan
}
