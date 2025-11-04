import type { Payload, PayloadHandler } from 'payload'

import { buildTranslatableItems } from '../components/auto-translate-button/utils/buildTranslatableItems.js'

import { generateLinkSyncPlan } from './linkSyncService.js'
import { getStoredCollection, getTranslationState } from './translationStateStore.js'
import { streamTranslations } from './translationStream.js'
import type { BulkStreamEvent, BulkTranslateRequestPayload } from './translationTypes.js'
import { looksLikeLink } from '../utils/linkDetection.js'

const encoder = new TextEncoder()

function serializeEvent(event: BulkStreamEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`)
}

function parseBulkLinkBody(body: unknown): BulkTranslateRequestPayload {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Invalid JSON body')
  }

  const candidate = body as Record<string, unknown>
  const collections = candidate.collections

  if (!Array.isArray(collections)) {
    throw new Error('Expected "collections" to be an array of collection slugs')
  }

  const sanitized = Array.from(
    new Set(
      collections
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter((value): value is string => Boolean(value)),
    ),
  )

  if (!sanitized.length) {
    throw new Error('No collections selected for link synchronization')
  }

  return { collections: sanitized }
}

function toIdentifier(value: unknown): string | number | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length ? trimmed : null
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'object' && value !== null) {
    if ('id' in value) {
      return toIdentifier((value as { id?: unknown }).id)
    }

    if ('_id' in value) {
      return toIdentifier((value as { _id?: unknown })._id)
    }
  }

  return null
}

function buildLinkItems(doc: unknown, patterns: string[]) {
  return buildTranslatableItems(doc, patterns).filter((item) => !item.lexical && looksLikeLink(item.text))
}

async function* runBulkLinkSync(payload: Payload, request: BulkTranslateRequestPayload) {
  const state = getTranslationState()
  const defaultLocale = state.defaultLocale
  const locales = state.locales.filter((locale) => locale && locale !== defaultLocale)

  if (!defaultLocale) {
    yield { type: 'error', message: 'Default locale is not configured for translations.' } as BulkStreamEvent
    return
  }

  if (!locales.length) {
    yield { type: 'error', message: 'No target locales available for link synchronization.' } as BulkStreamEvent
    return
  }

  const selected = request.collections
    .map((slug) => getStoredCollection(slug))
    .filter((entry): entry is NonNullable<ReturnType<typeof getStoredCollection>> => Boolean(entry))

  if (!selected.length) {
    yield { type: 'error', message: 'No matching collections configured for link synchronization.' }
    return
  }

  let totalDocuments = 0
  const totals = new Map<string, number>()

  for (const entry of selected) {
    try {
      const result = await payload.count({ collection: entry.slug, locale: defaultLocale })
      const count = typeof result === 'number' ? result : 0
      totals.set(entry.slug, count)
      totalDocuments += count
    } catch (_error) {
      totals.set(entry.slug, 0)
    }
  }

  yield { type: 'bulk-start', totalCollections: selected.length, totalDocuments } as BulkStreamEvent

  let processedTotal = 0
  let skippedTotal = 0
  let failedTotal = 0

  for (const entry of selected) {
    const totalForCollection = totals.get(entry.slug) ?? 0
    yield {
      type: 'collection-start',
      collection: entry.slug,
      label: entry.label,
      totalDocuments: totalForCollection,
    } as BulkStreamEvent

    let processed = 0
    let skipped = 0
    let failed = 0

    const limit = 50
    let page = 1
    let hasMore = true

    while (hasMore) {
      let result: Awaited<ReturnType<Payload['find']>>
      try {
        result = await payload.find({
          collection: entry.slug,
          depth: 0,
          fallbackLocale: false,
          limit,
          locale: defaultLocale,
          page,
        })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : `Failed to fetch documents for ${entry.slug}.`
        yield {
          type: 'document-error',
          collection: entry.slug,
          id: `${entry.slug}-page-${page}`,
          message,
        } as BulkStreamEvent
        failed += 1
        failedTotal += 1
        break
      }

      const docs = Array.isArray(result.docs) ? result.docs : []
      hasMore = Boolean(result.hasNextPage)
      page += 1

      if (!docs.length) {
        break
      }

      for (const doc of docs) {
        const identifier = toIdentifier((doc as { id?: unknown }).id) ??
          toIdentifier((doc as { _id?: unknown })._id)

        if (identifier === null) {
          skipped += 1
          skippedTotal += 1
          yield {
            type: 'document-skipped',
            collection: entry.slug,
            id: 'unknown',
            reason: 'Document is missing an identifier.',
          } as BulkStreamEvent
          continue
        }

        const docLabel = String(identifier)
        yield { type: 'document-start', collection: entry.slug, id: docLabel } as BulkStreamEvent

        const items = buildLinkItems(doc, entry.fieldPatterns)
        if (!items.length) {
          skipped += 1
          skippedTotal += 1
          yield {
            type: 'document-skipped',
            collection: entry.slug,
            id: docLabel,
            reason: 'No link fields found for synchronization.',
          } as BulkStreamEvent
          continue
        }

        const plan = await generateLinkSyncPlan(payload, {
          collection: entry.slug,
          from: defaultLocale,
          id: identifier,
          items,
          locales,
        })

        if (!plan.locales.length) {
          skipped += 1
          skippedTotal += 1
          yield {
            type: 'document-skipped',
            collection: entry.slug,
            id: docLabel,
            reason: 'Links are already up to date.',
          } as BulkStreamEvent
          continue
        }

        try {
          const localeRequests = plan.locales.map((locale) => ({
            chunks: [],
            code: locale.code,
            overrides: locale.overrides.map((override) => ({ ...items[override.index], text: override.text })),
          }))

          for await (const event of streamTranslations(payload, {
            id: identifier,
            collection: entry.slug,
            from: defaultLocale,
            locales: localeRequests,
          })) {
            if (event.type === 'progress') {
              yield {
                type: 'document-progress',
                collection: entry.slug,
                completed: event.completed,
                id: docLabel,
                locale: event.locale,
                total: event.total,
              } as BulkStreamEvent
            }

            if (event.type === 'applied') {
              yield {
                type: 'document-applied',
                collection: entry.slug,
                id: docLabel,
                locale: event.locale,
              } as BulkStreamEvent
            }

            if (event.type === 'error') {
              throw new Error(event.message || 'Link synchronization failed.')
            }
          }

          processed += 1
          processedTotal += 1
          yield { type: 'document-success', collection: entry.slug, id: docLabel } as BulkStreamEvent
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Link synchronization failed.'
          failed += 1
          failedTotal += 1
          yield {
            type: 'document-error',
            collection: entry.slug,
            id: docLabel,
            message,
          } as BulkStreamEvent
        }
      }
    }

    yield {
      type: 'collection-complete',
      collection: entry.slug,
      failed,
      processed,
      skipped,
    } as BulkStreamEvent
  }

  yield { type: 'bulk-complete', failed: failedTotal, processed: processedTotal, skipped: skippedTotal } as BulkStreamEvent
}

export function createBulkLinkSyncHandler(): PayloadHandler {
  return async (req) => {
    try {
      const payload = req.payload
      if (!payload) {
        throw new Error('Payload instance is not available on the request')
      }

      // @ts-expect-error payload provides json
      const parsed = parseBulkLinkBody(await req.json())
      const stream = new ReadableStream({
        async start(controller) {
          try {
            for await (const event of runBulkLinkSync(payload, parsed)) {
              controller.enqueue(serializeEvent(event))
              if (event.type === 'bulk-complete' || event.type === 'error') {
                break
              }
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Link synchronization failed.'
            controller.enqueue(serializeEvent({ type: 'error', message }))
          } finally {
            controller.close()
          }
        },
      })

      return new Response(stream, {
        headers: {
          'Cache-Control': 'no-cache, no-transform',
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request body'
      return Response.json({ message }, { status: 400 })
    }
  }
}
