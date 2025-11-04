import type { PayloadHandler } from 'payload'

import { generateLinkSyncPlan } from './linkSyncService.js'
import type { LinkSyncRequestPayload } from './translationTypes.js'

function isLinkSyncItem(value: unknown): value is LinkSyncRequestPayload['items'][number] {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { lexical?: unknown }).lexical === 'boolean' &&
    typeof (value as { path?: unknown }).path === 'string' &&
    typeof (value as { text?: unknown }).text === 'string'
  )
}

function parseLinkSyncBody(body: unknown): LinkSyncRequestPayload {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Invalid JSON body')
  }

  const candidate = body as Record<string, unknown>
  const collection = candidate.collection
  const from = candidate.from
  const identifier = candidate.id
  const locales = candidate.locales
  const items = candidate.items

  if (typeof collection !== 'string' || !collection) {
    throw new Error('Missing "collection" slug')
  }

  if (typeof from !== 'string' || !from) {
    throw new Error('Missing "from" locale')
  }

  if (typeof identifier !== 'string' && typeof identifier !== 'number') {
    throw new Error('Missing document "id"')
  }

  if (typeof identifier === 'string' && !identifier.trim()) {
    throw new Error('Missing document "id"')
  }

  if (!Array.isArray(locales)) {
    throw new Error('Expected "locales" to be an array of locale codes')
  }

  const localeCodes = locales
    .map((value) => (typeof value === 'string' ? value : '').trim())
    .filter((value): value is string => Boolean(value))

  if (!localeCodes.length) {
    throw new Error('No target locales provided')
  }

  if (!Array.isArray(items) || !items.every(isLinkSyncItem)) {
    throw new Error('Expected "items" to be an array of link fields')
  }

  return {
    collection,
    from,
    id: typeof identifier === 'string' ? identifier.trim() : identifier,
    items,
    locales: localeCodes,
  }
}

export function createLinkSyncHandler(): PayloadHandler {
  return async (req) => {
    try {
      const payload = req.payload
      if (!payload) {
        throw new Error('Payload instance is not available on the request')
      }

      // @ts-expect-error -- payload adds json() on the request
      const parsed = parseLinkSyncBody(await req.json())
      const plan = await generateLinkSyncPlan(payload, parsed)
      return Response.json(plan)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request body'
      return Response.json({ message }, { status: 400 })
    }
  }
}
