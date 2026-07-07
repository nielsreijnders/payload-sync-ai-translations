import type { Payload, PayloadHandler } from 'payload'

import type {
  BulkStreamEvent,
  BulkTranslateRequestPayload,
  TranslateLocaleRequestPayload,
  TranslateReviewLocale,
} from './translationTypes.js'

import {
  buildTranslatableItems,
  collectIdentifierPaths,
  collectSkippedTranslatablePaths,
} from '../components/auto-translate-button/utils/buildTranslatableItems.js'
import { chunkItems } from '../utils/localizedFields.js'
import { logDebug } from './debugSettings.js'
import { rejectUnauthenticated } from './requireUser.js'
import { generateTranslationReview } from './translationReviewService.js'
import { getStoredCollection, getTranslationState } from './translationStateStore.js'
import { streamTranslations } from './translationStream.js'

const encoder = new TextEncoder()

function serializeEvent(event: BulkStreamEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`)
}

function normalizeSkipFields(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,\n;]/)
      : []

  return Array.from(
    new Set(
      raw
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  )
}

function parseDocumentsFilter(
  value: unknown,
): BulkTranslateRequestPayload['documents'] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }

  const parsed: Record<string, Array<number | string>> = {}

  for (const [slug, rawIds] of Object.entries(value as Record<string, unknown>)) {
    if (!slug.trim() || !Array.isArray(rawIds)) {
      continue
    }

    const ids = rawIds.filter(
      (id): id is number | string =>
        (typeof id === 'string' && Boolean(id.trim())) ||
        (typeof id === 'number' && Number.isFinite(id)),
    )

    if (ids.length) {
      parsed[slug.trim()] = ids
    }
  }

  return Object.keys(parsed).length ? parsed : undefined
}

function parseBulkBody(body: unknown): BulkTranslateRequestPayload {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Invalid JSON body')
  }

  const candidate = body as Record<string, unknown>
  const collections = candidate.collections
  const overwrite = candidate.overwrite === true
  const skipFields = normalizeSkipFields(candidate.skipFields)
  const documents = parseDocumentsFilter(candidate.documents)

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

  return { collections: sanitized, documents, overwrite, skipFields }
}

function toIdentifier(value: unknown): null | number | string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length ? trimmed : null
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
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
  identifierPaths: ReturnType<typeof collectIdentifierPaths>,
  preservePaths: string[],
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
        .filter((entry): entry is (typeof items)[number] => Boolean(entry))

      const translateIndexes = Array.from(new Set(locale.translateIndexes))
        .filter((index) => Number.isInteger(index) && index >= 0 && index < items.length)
        .filter((index) => !overrideMap.has(index))

      const toTranslate = translateIndexes
        .map((index) => items[index])
        .filter((entry): entry is (typeof items)[number] => Boolean(entry))

      return {
        chunks: chunkItems(toTranslate),
        code: locale.code,
        identifierPaths,
        overrides,
        preservePaths,
      }
    })
    .filter((locale) => locale.chunks.length || (locale.overrides?.length ?? 0) > 0)
}

function buildOverwriteLocaleRequests(
  items: ReturnType<typeof buildTranslatableItems>,
  locales: string[],
  identifierPaths: ReturnType<typeof collectIdentifierPaths>,
  preservePaths: string[],
): TranslateLocaleRequestPayload[] {
  if (!items.length) {
    return []
  }

  const chunks = chunkItems(items)

  return locales.map((code) => ({
    chunks,
    code,
    identifierPaths,
    preservePaths,
  }))
}

async function* runBulkTranslations(
  payload: Payload,
  request: BulkTranslateRequestPayload,
): AsyncGenerator<BulkStreamEvent> {
  const state = getTranslationState()
  const defaultLocale = state.defaultLocale
  const targetLocales = state.locales.filter((code) => code && code !== defaultLocale)
  const skipFields = request.skipFields ?? []

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

  logDebug(payload, '[AI Translate] Bulk translation collections resolved.', {
    defaultLocale,
    overwrite: Boolean(request.overwrite),
    requestedCollections: request.collections,
    resolvedCollections: selected.map((entry) => ({
      slug: entry.slug,
      fieldPatterns: entry.fieldPatterns,
      label: entry.label,
    })),
    skipFields,
    targetLocales,
  })

  const totals = new Map<string, number>()
  let grandTotal = 0

  for (const entry of selected) {
    try {
      const documentIds = request.documents?.[entry.slug]
      const result = await payload.find({
        collection: entry.slug,
        depth: 0,
        fallbackLocale: false,
        limit: 1,
        locale: defaultLocale,
        page: 1,
        ...(documentIds ? { where: { id: { in: documentIds } } } : {}),
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

  logDebug(payload, '[AI Translate] Bulk translation totals calculated.', {
    grandTotal,
    totals: Object.fromEntries(totals.entries()),
  })

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
      const documentIds = request.documents?.[entry.slug]
      let result: Awaited<ReturnType<Payload['find']>>
      try {
        result = await payload.find({
          collection: entry.slug,
          depth: 0,
          fallbackLocale: false,
          limit,
          locale: defaultLocale,
          page,
          ...(documentIds ? { where: { id: { in: documentIds } } } : {}),
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
        const docIdentifier =
          toIdentifier((doc as { id?: unknown }).id) ??
          toIdentifier((doc as { _id?: unknown })._id) ??
          null

        if (docIdentifier === null) {
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

        const docLabel = String(docIdentifier)

        payload.logger?.info?.(
          `[AI Translate] Starting bulk translation for ${entry.slug}#${docLabel}.`,
        )
        yield { id: docLabel, type: 'document-start', collection: entry.slug }

        const identifierPaths = collectIdentifierPaths(doc, entry.fieldPatterns)
        const preservePaths = collectSkippedTranslatablePaths(doc, entry.fieldPatterns, skipFields)
        const items = buildTranslatableItems(doc, entry.fieldPatterns, { skipFields })

        logDebug(payload, '[AI Translate] Built translatable items for bulk document.', {
          collection: entry.slug,
          documentId: docIdentifier,
          itemCount: items.length,
          preservePathCount: preservePaths.length,
          skippedFields: skipFields,
        })

        if (!items.length) {
          collectionSkipped += 1
          overallSkipped += 1
          payload.logger?.info?.(
            `[AI Translate] Skipped ${entry.slug}#${docLabel}: no translatable fields found.`,
          )
          yield {
            id: docLabel,
            type: 'document-skipped',
            collection: entry.slug,
            reason: 'No translatable fields found.',
          }
          continue
        }

        let localeRequests: TranslateLocaleRequestPayload[]

        if (request.overwrite) {
          localeRequests = buildOverwriteLocaleRequests(
            items,
            targetLocales,
            identifierPaths,
            preservePaths,
          )
          logDebug(payload, '[AI Translate] Prepared overwrite locale requests for bulk document.', {
            collection: entry.slug,
            documentId: docIdentifier,
            locales: localeRequests.map((locale) => ({
              chunkCount: locale.chunks.length,
              code: locale.code,
            })),
          })
        } else {
          let review
          try {
            review = await generateTranslationReview(payload, {
              id: docIdentifier,
              collection: entry.slug,
              from: defaultLocale,
              items,
              locales: targetLocales,
            })
            logDebug(payload, '[AI Translate] Generated translation review for bulk document.', {
              collection: entry.slug,
              documentId: docIdentifier,
              locales: review.locales.map((locale) => ({
                code: locale.code,
                suggestions: locale.suggestions?.length ?? 0,
                translateIndexes: locale.translateIndexes,
              })),
            })
          } catch (error) {
            const message =
              error instanceof Error ? error.message : 'Translation review failed for document.'
            collectionFailed += 1
            overallFailed += 1
            payload.logger?.error?.(
              `[AI Translate] Review failed for ${entry.slug}#${docLabel}: ${message}`,
            )
            yield { id: docLabel, type: 'document-error', collection: entry.slug, message }
            continue
          }

          localeRequests = buildLocaleRequests(items, review.locales, identifierPaths, preservePaths)
        }

        logDebug(payload, '[AI Translate] Prepared locale requests for bulk document.', {
          collection: entry.slug,
          documentId: docIdentifier,
          locales: localeRequests.map((locale) => ({
            chunkCount: locale.chunks.length,
            code: locale.code,
            overrideCount: locale.overrides?.length ?? 0,
          })),
        })

        if (!localeRequests.length) {
          collectionSkipped += 1
          overallSkipped += 1
          payload.logger?.info?.(
            `[AI Translate] Skipped ${entry.slug}#${docLabel}: translations are up to date.`,
          )
          yield {
            id: docLabel,
            type: 'document-skipped',
            collection: entry.slug,
            reason: 'Translations are already up to date.',
          }
          continue
        }

        let hadError = false

        try {
          for await (const event of streamTranslations(payload, {
            id: docIdentifier,
            collection: entry.slug,
            from: defaultLocale,
            locales: localeRequests,
          })) {
            switch (event.type) {
              case 'applied':
                payload.logger?.info?.(
                  `[AI Translate] Saved translations for ${entry.slug}#${docLabel} (${event.locale}).`,
                )
                yield {
                  id: docLabel,
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
                  `[AI Translate] Failed to translate ${entry.slug}#${docLabel}: ${event.message}`,
                )
                yield {
                  id: docLabel,
                  type: 'document-error',
                  collection: entry.slug,
                  message: event.message,
                }
                break
              case 'progress':
                yield {
                  id: docLabel,
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
            `[AI Translate] Unexpected error for ${entry.slug}#${docLabel}: ${message}`,
          )
          yield { id: docLabel, type: 'document-error', collection: entry.slug, message }
        }

        if (hadError) {
          continue
        }

        collectionProcessed += 1
        overallProcessed += 1
        payload.logger?.info?.(
          `[AI Translate] Completed translations for ${entry.slug}#${docLabel}.`,
        )
        yield { id: docLabel, type: 'document-success', collection: entry.slug }
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
    const unauthorized = rejectUnauthenticated(req)
    if (unauthorized) {
      return unauthorized
    }

    try {
      const payload = req.payload
      if (!payload) {
        throw new Error('Payload instance is not available on the request')
      }

      // @ts-expect-error body parsing will be provided by payload
      const parsed = parseBulkBody(await req.json())

      logDebug(payload, '[AI Translate] Parsed bulk translation request.', {
        collections: parsed.collections,
        overwrite: parsed.overwrite,
        skipFields: parsed.skipFields,
      })

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
