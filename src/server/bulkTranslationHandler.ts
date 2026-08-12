import type { Payload, PayloadHandler } from 'payload'

import type {
  BulkStreamEvent,
  BulkTranslateRequestPayload,
  TranslateLocaleRequestPayload,
  TranslateReviewLocale,
  TranslationTarget,
} from './translationTypes.js'

import {
  buildTranslatableItems,
  collectIdentifierPaths,
  collectSkippedTranslatablePaths,
} from '../components/auto-translate-button/utils/buildTranslatableItems.js'
import { chunkItems } from '../utils/localizedFields.js'
import { parseDocumentsFilter, sanitizeSlugArray } from './bulkRequestParsing.js'
import { logDebug } from './debugSettings.js'
import { rejectUnauthenticated } from './requireUser.js'
import { generateTranslationReview } from './translationReviewService.js'
import {
  getStoredCollection,
  getStoredGlobal,
  getTranslationState,
} from './translationStateStore.js'
import { streamTranslations } from './translationStream.js'

type StoredTargetEntry = NonNullable<ReturnType<typeof getStoredCollection>>

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

function parseBulkBody(body: unknown): BulkTranslateRequestPayload {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Invalid JSON body')
  }

  const candidate = body as Record<string, unknown>
  const overwrite = candidate.overwrite === true
  const skipFields = normalizeSkipFields(candidate.skipFields)
  const documents = parseDocumentsFilter(candidate.documents)

  if (candidate.collections !== undefined && !Array.isArray(candidate.collections)) {
    throw new Error('Expected "collections" to be an array of collection slugs')
  }

  if (candidate.globals !== undefined && !Array.isArray(candidate.globals)) {
    throw new Error('Expected "globals" to be an array of global slugs')
  }

  const collections = sanitizeSlugArray(candidate.collections)
  const globals = sanitizeSlugArray(candidate.globals)

  if (!collections.length && !globals.length) {
    throw new Error('No collections or globals selected for bulk translation')
  }

  return { collections, documents, globals, overwrite, skipFields }
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

type DocumentOutcome = 'failed' | 'processed' | 'skipped'

/**
 * Translates one resolved document (a collection document or a global) and
 * yields its bulk stream events. Returns the outcome so callers can update
 * their counters.
 */
async function* translateResolvedDocument(
  payload: Payload,
  options: {
    defaultLocale: string
    doc: unknown
    entry: StoredTargetEntry
    eventCollection: string
    eventId: string
    overwrite: boolean
    skipFields: string[]
    target: TranslationTarget
    targetLabel: string
    targetLocales: string[]
  },
): AsyncGenerator<BulkStreamEvent, DocumentOutcome> {
  const {
    defaultLocale,
    doc,
    entry,
    eventCollection,
    eventId,
    overwrite,
    skipFields,
    target,
    targetLabel,
    targetLocales,
  } = options

  payload.logger?.info?.(`[AI Translate] Starting bulk translation for ${targetLabel}.`)
  yield { id: eventId, type: 'document-start', collection: eventCollection }

  const identifierPaths = collectIdentifierPaths(doc, entry.fieldPatterns)
  const preservePaths = collectSkippedTranslatablePaths(doc, entry.fieldPatterns, skipFields)
  const items = buildTranslatableItems(doc, entry.fieldPatterns, { skipFields })

  logDebug(payload, '[AI Translate] Built translatable items for bulk document.', {
    collection: eventCollection,
    documentId: eventId,
    itemCount: items.length,
    preservePathCount: preservePaths.length,
    skippedFields: skipFields,
  })

  if (!items.length) {
    payload.logger?.info?.(`[AI Translate] Skipped ${targetLabel}: no translatable fields found.`)
    yield {
      id: eventId,
      type: 'document-skipped',
      collection: eventCollection,
      reason: 'No translatable fields found.',
    }
    return 'skipped'
  }

  let localeRequests: TranslateLocaleRequestPayload[]

  if (overwrite) {
    localeRequests = buildOverwriteLocaleRequests(
      items,
      targetLocales,
      identifierPaths,
      preservePaths,
    )
    logDebug(payload, '[AI Translate] Prepared overwrite locale requests for bulk document.', {
      collection: eventCollection,
      documentId: eventId,
      locales: localeRequests.map((locale) => ({
        chunkCount: locale.chunks.length,
        code: locale.code,
      })),
    })
  } else {
    let review
    try {
      review = await generateTranslationReview(payload, {
        ...target,
        from: defaultLocale,
        items,
        locales: targetLocales,
      })
      logDebug(payload, '[AI Translate] Generated translation review for bulk document.', {
        collection: eventCollection,
        documentId: eventId,
        locales: review.locales.map((locale) => ({
          code: locale.code,
          suggestions: locale.suggestions?.length ?? 0,
          translateIndexes: locale.translateIndexes,
        })),
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Translation review failed for document.'
      payload.logger?.error?.(`[AI Translate] Review failed for ${targetLabel}: ${message}`)
      yield { id: eventId, type: 'document-error', collection: eventCollection, message }
      return 'failed'
    }

    localeRequests = buildLocaleRequests(items, review.locales, identifierPaths, preservePaths)
  }

  logDebug(payload, '[AI Translate] Prepared locale requests for bulk document.', {
    collection: eventCollection,
    documentId: eventId,
    locales: localeRequests.map((locale) => ({
      chunkCount: locale.chunks.length,
      code: locale.code,
      overrideCount: locale.overrides?.length ?? 0,
    })),
  })

  if (!localeRequests.length) {
    payload.logger?.info?.(`[AI Translate] Skipped ${targetLabel}: translations are up to date.`)
    yield {
      id: eventId,
      type: 'document-skipped',
      collection: eventCollection,
      reason: 'Translations are already up to date.',
    }
    return 'skipped'
  }

  let hadError = false

  try {
    for await (const event of streamTranslations(payload, {
      ...target,
      from: defaultLocale,
      locales: localeRequests,
    })) {
      switch (event.type) {
        case 'applied':
          payload.logger?.info?.(
            `[AI Translate] Saved translations for ${targetLabel} (${event.locale}).`,
          )
          yield {
            id: eventId,
            type: 'document-applied',
            collection: eventCollection,
            locale: event.locale,
          }
          break
        case 'done':
          break
        case 'error':
          hadError = true
          payload.logger?.error?.(
            `[AI Translate] Failed to translate ${targetLabel}: ${event.message}`,
          )
          yield {
            id: eventId,
            type: 'document-error',
            collection: eventCollection,
            message: event.message,
          }
          break
        case 'progress':
          yield {
            id: eventId,
            type: 'document-progress',
            collection: eventCollection,
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
    const message = error instanceof Error ? error.message : 'Unexpected failure while translating.'
    payload.logger?.error?.(`[AI Translate] Unexpected error for ${targetLabel}: ${message}`)
    yield { id: eventId, type: 'document-error', collection: eventCollection, message }
    return 'failed'
  }

  if (hadError) {
    return 'failed'
  }

  payload.logger?.info?.(`[AI Translate] Completed translations for ${targetLabel}.`)
  yield { id: eventId, type: 'document-success', collection: eventCollection }
  return 'processed'
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
    .filter((entry): entry is StoredTargetEntry => Boolean(entry))
  const selectedGlobals = (request.globals ?? [])
    .map((slug) => getStoredGlobal(slug))
    .filter((entry): entry is StoredTargetEntry => Boolean(entry))

  if (!selected.length && !selectedGlobals.length) {
    yield {
      type: 'error',
      message: 'No matching collections or globals configured for translations.',
    }
    return
  }

  logDebug(payload, '[AI Translate] Bulk translation targets resolved.', {
    defaultLocale,
    overwrite: Boolean(request.overwrite),
    requestedCollections: request.collections,
    requestedGlobals: request.globals ?? [],
    resolvedCollections: selected.map((entry) => ({
      slug: entry.slug,
      fieldPatterns: entry.fieldPatterns,
      label: entry.label,
    })),
    resolvedGlobals: selectedGlobals.map((entry) => ({
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

  for (const entry of selectedGlobals) {
    totals.set(`global:${entry.slug}`, 1)
    grandTotal += 1
  }

  payload.logger?.info?.(
    `[AI Translate] Starting bulk translation for ${selected.length + selectedGlobals.length} targets (total documents: ${grandTotal}).`,
  )

  logDebug(payload, '[AI Translate] Bulk translation totals calculated.', {
    grandTotal,
    totals: Object.fromEntries(totals.entries()),
  })

  yield {
    type: 'bulk-start',
    totalCollections: selected.length + selectedGlobals.length,
    totalDocuments: grandTotal,
  }

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
        const outcome = yield* translateResolvedDocument(payload, {
          defaultLocale,
          doc,
          entry,
          eventCollection: entry.slug,
          eventId: docLabel,
          overwrite: Boolean(request.overwrite),
          skipFields,
          target: { id: docIdentifier, collection: entry.slug },
          targetLabel: `${entry.slug}#${docLabel}`,
          targetLocales,
        })

        if (outcome === 'processed') {
          collectionProcessed += 1
          overallProcessed += 1
        } else if (outcome === 'skipped') {
          collectionSkipped += 1
          overallSkipped += 1
        } else {
          collectionFailed += 1
          overallFailed += 1
        }
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

  for (const entry of selectedGlobals) {
    const eventCollection = `global:${entry.slug}`

    payload.logger?.info?.(`[AI Translate] Processing global ${entry.slug}.`)
    yield {
      type: 'collection-start',
      collection: eventCollection,
      label: entry.label,
      totalDocuments: 1,
    }

    let outcome: DocumentOutcome

    try {
      const doc = await payload.findGlobal({
        slug: entry.slug,
        depth: 0,
        fallbackLocale: false,
        locale: defaultLocale,
      })

      outcome = yield* translateResolvedDocument(payload, {
        defaultLocale,
        doc,
        entry,
        eventCollection,
        eventId: entry.slug,
        overwrite: Boolean(request.overwrite),
        skipFields,
        target: { global: entry.slug },
        targetLabel: eventCollection,
        targetLocales,
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Failed to load global ${entry.slug}.`
      payload.logger?.error?.(`[AI Translate] ${message}`)
      yield { id: entry.slug, type: 'document-error', collection: eventCollection, message }
      outcome = 'failed'
    }

    if (outcome === 'processed') {
      overallProcessed += 1
    } else if (outcome === 'skipped') {
      overallSkipped += 1
    } else {
      overallFailed += 1
    }

    payload.logger?.info?.(
      `[AI Translate] Finished global ${entry.slug}: ${outcome === 'processed' ? 1 : 0} processed, ${outcome === 'skipped' ? 1 : 0} skipped, ${outcome === 'failed' ? 1 : 0} failed.`,
    )

    yield {
      type: 'collection-complete',
      collection: eventCollection,
      failed: outcome === 'failed' ? 1 : 0,
      processed: outcome === 'processed' ? 1 : 0,
      skipped: outcome === 'skipped' ? 1 : 0,
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
        globals: parsed.globals,
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
