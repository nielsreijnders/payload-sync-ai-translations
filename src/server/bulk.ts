import type { Payload, PayloadHandler } from 'payload'

import type {
  BulkStreamEvent,
  BulkTranslateRequestPayload,
  TranslateLocaleRequestPayload,
  TranslateReviewLocale,
} from './types.js'

import { buildTranslatableItems } from '../components/auto-translate-button/utils/buildTranslatableItems.js'
import { chunkItems } from '../utils/localizedFields.js'
import { generateTranslationReview } from './review.js'
import { getStoredCollection, getTranslationState } from './state.js'
import { streamTranslations } from './stream.js'

const encoder = new TextEncoder()

function serializeEvent(event: BulkStreamEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`)
}

function parseBulkBody(body: unknown): BulkTranslateRequestPayload {
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
    throw new Error('No collections selected for bulk translation')
  }

  return { collections: sanitized }
}

function toIdentifier(value: unknown): null | string {
  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }

  if (typeof value === 'object' && value !== null && 'id' in value) {
    const nested = (value as { id?: unknown }).id
    return toIdentifier(nested)
  }

  return null
}

function buildLocaleRequests(
  items: ReturnType<typeof buildTranslatableItems>,
  locales: TranslateReviewLocale[],
): TranslateLocaleRequestPayload[] {
  return locales
    .map((locale) => {
      const overrideMap = new Map<number, string>()
      for (const suggestion of locale.suggestions ?? []) {
        if (!Number.isInteger(suggestion.index)) {
          continue
        }

        const trimmed = typeof suggestion.text === 'string' ? suggestion.text.trim() : ''
        if (!trimmed) {
          continue
        }

        overrideMap.set(suggestion.index, trimmed)
      }

      const overrides = Array.from(overrideMap.entries())
        .map(([index, text]) => {
          const source = items[index]
          if (!source) {
            return null
          }

          return { ...source, text }
        })
        .filter((entry): entry is typeof items[number] => Boolean(entry))

      const translateIndexes = Array.from(new Set(locale.translateIndexes))
        .filter((index) => Number.isInteger(index) && index >= 0 && index < items.length)
        .filter((index) => !overrideMap.has(index))

      const toTranslate = translateIndexes
        .map((index) => items[index])
        .filter((entry): entry is typeof items[number] => Boolean(entry))

      return {
        chunks: chunkItems(toTranslate),
        code: locale.code,
        overrides,
      }
    })
    .filter((locale) => locale.chunks.length || (locale.overrides?.length ?? 0) > 0)
}

async function* runBulkTranslations(
  payload: Payload,
  request: BulkTranslateRequestPayload,
): AsyncGenerator<BulkStreamEvent> {
  const state = getTranslationState()
  const defaultLocale = state.defaultLocale
  const targetLocales = state.locales.filter((code) => code && code !== defaultLocale)

  if (!defaultLocale) {
    yield { type: 'error', message: 'Default locale is not configured for translations.' }
    return
  }

  if (!targetLocales.length) {
    yield { type: 'error', message: 'No target locales available for translations.' }
    return
  }

  const selected = request.collections
    .map((slug) => getStoredCollection(slug))
    .filter((entry): entry is NonNullable<ReturnType<typeof getStoredCollection>> => Boolean(entry))

  if (!selected.length) {
    yield { type: 'error', message: 'No matching collections configured for translations.' }
    return
  }

  const totals = new Map<string, number>()
  let grandTotal = 0

  for (const entry of selected) {
    try {
      const result = await payload.find({
        collection: entry.slug,
        depth: 0,
        fallbackLocale: false,
        limit: 1,
        locale: defaultLocale,
        page: 1,
      })

      const totalDocs = typeof result.totalDocs === 'number' ? result.totalDocs : 0
      totals.set(entry.slug, totalDocs)
      grandTotal += totalDocs
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `Failed to count documents for collection ${entry.slug}.`
      payload.logger?.error?.(`[AI Translate] ${message}`)
      totals.set(entry.slug, 0)
    }
  }

  payload.logger?.info?.(
    `[AI Translate] Starting bulk translation for ${selected.length} collections (total documents: ${grandTotal}).`,
  )

  yield { type: 'bulk-start', totalCollections: selected.length, totalDocuments: grandTotal }

  let overallProcessed = 0
  let overallSkipped = 0
  let overallFailed = 0

  for (const entry of selected) {
    const totalForCollection = totals.get(entry.slug) ?? 0
    let collectionProcessed = 0
    let collectionSkipped = 0
    let collectionFailed = 0

    payload.logger?.info?.(
      `[AI Translate] Processing collection ${entry.slug} (${totalForCollection} documents).`,
    )
    yield {
      type: 'collection-start',
      collection: entry.slug,
      label: entry.label,
      totalDocuments: totalForCollection,
    }

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
          error instanceof Error
            ? error.message
            : `Failed to fetch documents for collection ${entry.slug}.`
        payload.logger?.error?.(`[AI Translate] ${message}`)
        yield {
          id: `${entry.slug}-page-${page}`,
          type: 'document-error',
          collection: entry.slug,
          message,
        }
        collectionFailed += 1
        overallFailed += 1
        break
      }

      const docs = Array.isArray(result.docs) ? result.docs : []
      hasMore = Boolean(result.hasNextPage)
      page += 1

      if (!docs.length) {
        break
      }

      for (const doc of docs) {
        const docId =
          toIdentifier((doc as { id?: unknown }).id) ??
          toIdentifier((doc as { _id?: unknown })._id) ??
          ''

        if (!docId) {
          collectionSkipped += 1
          overallSkipped += 1
          payload.logger?.warn?.(
            `[AI Translate] Skipped document without identifier in collection ${entry.slug}.`,
          )
          yield {
            id: 'unknown',
            type: 'document-skipped',
            collection: entry.slug,
            reason: 'Document is missing an identifier.',
          }
          continue
        }

        payload.logger?.info?.(
          `[AI Translate] Starting bulk translation for ${entry.slug}#${docId}.`,
        )
        yield { id: docId, type: 'document-start', collection: entry.slug }

        const items = buildTranslatableItems(doc, entry.fieldPatterns)

        if (!items.length) {
          collectionSkipped += 1
          overallSkipped += 1
          payload.logger?.info?.(
            `[AI Translate] Skipped ${entry.slug}#${docId}: no translatable fields found.`,
          )
          yield {
            id: docId,
            type: 'document-skipped',
            collection: entry.slug,
            reason: 'No translatable fields found.',
          }
          continue
        }

        let review
        try {
          review = await generateTranslationReview(payload, {
            id: docId,
            collection: entry.slug,
            from: defaultLocale,
            items,
            locales: targetLocales,
          })
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Translation review failed for document.'
          collectionFailed += 1
          overallFailed += 1
          payload.logger?.error?.(
            `[AI Translate] Review failed for ${entry.slug}#${docId}: ${message}`,
          )
          yield { id: docId, type: 'document-error', collection: entry.slug, message }
          continue
        }

        const localeRequests = buildLocaleRequests(items, review.locales)

        if (!localeRequests.length) {
          collectionSkipped += 1
          overallSkipped += 1
          payload.logger?.info?.(
            `[AI Translate] Skipped ${entry.slug}#${docId}: translations are up to date.`,
          )
          yield {
            id: docId,
            type: 'document-skipped',
            collection: entry.slug,
            reason: 'Translations are already up to date.',
          }
          continue
        }

        let hadError = false

        try {
          for await (const event of streamTranslations(payload, {
            id: docId,
            collection: entry.slug,
            from: defaultLocale,
            locales: localeRequests,
          })) {
            switch (event.type) {
              case 'applied':
                payload.logger?.info?.(
                  `[AI Translate] Saved translations for ${entry.slug}#${docId} (${event.locale}).`,
                )
                yield {
                  id: docId,
                  type: 'document-applied',
                  collection: entry.slug,
                  locale: event.locale,
                }
                break
              case 'done':
                break
              case 'error':
                hadError = true
                collectionFailed += 1
                overallFailed += 1
                payload.logger?.error?.(
                  `[AI Translate] Failed to translate ${entry.slug}#${docId}: ${event.message}`,
                )
                yield {
                  id: docId,
                  type: 'document-error',
                  collection: entry.slug,
                  message: event.message,
                }
                break
              case 'progress':
                yield {
                  id: docId,
                  type: 'document-progress',
                  collection: entry.slug,
                  completed: event.completed,
                  locale: event.locale,
                  total: event.total,
                }
                break
              default:
                break
            }

            if (hadError) {
              break
            }
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Unexpected failure while translating.'
          hadError = true
          collectionFailed += 1
          overallFailed += 1
          payload.logger?.error?.(
            `[AI Translate] Unexpected error for ${entry.slug}#${docId}: ${message}`,
          )
          yield { id: docId, type: 'document-error', collection: entry.slug, message }
        }

        if (hadError) {
          continue
        }

        collectionProcessed += 1
        overallProcessed += 1
        payload.logger?.info?.(
          `[AI Translate] Completed translations for ${entry.slug}#${docId}.`,
        )
        yield { id: docId, type: 'document-success', collection: entry.slug }
      }
    }

    payload.logger?.info?.(
      `[AI Translate] Finished collection ${entry.slug}: ${collectionProcessed} processed, ${collectionSkipped} skipped, ${collectionFailed} failed.`,
    )

    yield {
      type: 'collection-complete',
      collection: entry.slug,
      failed: collectionFailed,
      processed: collectionProcessed,
      skipped: collectionSkipped,
    }
  }

  payload.logger?.info?.(
    `[AI Translate] Bulk translation complete. Success: ${overallProcessed}, Skipped: ${overallSkipped}, Failed: ${overallFailed}.`,
  )

  yield {
    type: 'bulk-complete',
    failed: overallFailed,
    processed: overallProcessed,
    skipped: overallSkipped,
  }
}

export function createAiBulkTranslateHandler(): PayloadHandler {
  return async (req) => {
    try {
      const payload = req.payload
      if (!payload) {
        throw new Error('Payload instance is not available on the request')
      }

      // @ts-expect-error body parsing will be provided by payload
      const parsed = parseBulkBody(await req.json())

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const event of runBulkTranslations(payload, parsed)) {
              controller.enqueue(serializeEvent(event))
              if (event.type === 'error') {
                break
              }
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : 'Failed to run bulk translations.'
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
      return Response.json({ type: 'error', message }, { status: 400 })
    }
  }
}
