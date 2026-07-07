import type { Payload, PayloadHandler, PayloadRequest } from 'payload'

import type { StoredSyncRecord } from './syncStatusStore.js'
import type {
  SyncStatusDocument,
  SyncStatusScanEvent,
  SyncStatusScanRequest,
} from './syncStatusTypes.js'
import type { StoredEntry } from './translationStateStore.js'

import { buildTranslatableItems } from '../components/auto-translate-button/utils/buildTranslatableItems.js'
import { sanitizeSlugArray, toIdentifier } from './bulkRequestParsing.js'
import { rejectUnauthenticated } from './requireUser.js'
import {
  buildSyncSnapshot,
  buildTargetKey,
  computeLocaleStatuses,
  fetchSyncRecords,
} from './syncStatusStore.js'
import {
  getStoredCollection,
  getStoredGlobal,
  getTranslationState,
} from './translationStateStore.js'

const encoder = new TextEncoder()

function serializeEvent(event: SyncStatusScanEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`)
}

function parseScanRequest(body: unknown): SyncStatusScanRequest {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Invalid JSON body.')
  }

  const candidate = body as Record<string, unknown>
  const collections = sanitizeSlugArray(candidate.collections)
  const globals = sanitizeSlugArray(candidate.globals)

  if (!collections.length && !globals.length) {
    throw new Error('Select at least one collection or global.')
  }

  return { collections, globals }
}

function resolveDocumentLabel(doc: Record<string, unknown>, fallback: string): string {
  for (const key of ['title', 'name', 'label', 'slug']) {
    const value = doc[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return fallback
}

function buildStatusDocument(options: {
  collection?: string
  doc: Record<string, unknown>
  entry: StoredEntry
  global?: string
  id?: number | string
  records: StoredSyncRecord[]
  targetLocales: string[]
}): SyncStatusDocument {
  const { collection, doc, entry, global, id, records, targetLocales } = options
  const items = buildTranslatableItems(doc, entry.fieldPatterns)
  const snapshot = buildSyncSnapshot(items)
  const locales = computeLocaleStatuses(snapshot, records, targetLocales)
  const fallbackLabel = global ? entry.label : `${entry.label} ${String(id ?? '')}`.trim()

  return {
    id,
    collection,
    global,
    label: resolveDocumentLabel(doc, fallbackLabel),
    locales,
    maxChangedFields: locales.reduce((max, locale) => Math.max(max, locale.changedFields), 0),
    totalFields: items.length,
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : undefined,
  }
}

async function* runSyncStatusScan(
  req: PayloadRequest,
  request: SyncStatusScanRequest,
): AsyncGenerator<SyncStatusScanEvent> {
  const payload = req.payload
  const state = getTranslationState()
  const defaultLocale = state.defaultLocale
  const targetLocales = state.locales.filter((code) => code && code !== defaultLocale)

  if (!defaultLocale || !targetLocales.length) {
    yield { type: 'error', message: 'Localization is not configured for translation sync.' }
    return
  }

  const selectedCollections = request.collections
    .map((slug) => getStoredCollection(slug))
    .filter((entry): entry is StoredEntry => Boolean(entry))
  const selectedGlobals = request.globals
    .map((slug) => getStoredGlobal(slug))
    .filter((entry): entry is StoredEntry => Boolean(entry))

  if (!selectedCollections.length && !selectedGlobals.length) {
    yield { type: 'error', message: 'No matching collections or globals are configured.' }
    return
  }

  const totals = new Map<string, number>()
  let totalDocuments = selectedGlobals.length

  for (const entry of selectedCollections) {
    try {
      const counted = await payload.count({
        collection: entry.slug,
        overrideAccess: false,
        req,
      })
      totals.set(entry.slug, counted.totalDocs)
      totalDocuments += counted.totalDocs
    } catch {
      totals.set(entry.slug, 0)
    }
  }

  yield {
    type: 'scan-start',
    totalCollections: selectedCollections.length + selectedGlobals.length,
    totalDocuments,
  }

  let processed = 0
  let outOfSync = 0

  const emitTracking = (document: SyncStatusDocument): boolean => {
    processed += 1
    return document.locales.some((locale) => locale.status !== 'synced')
  }

  for (const entry of selectedCollections) {
    yield {
      type: 'collection-start',
      collection: entry.slug,
      label: entry.label,
      totalDocuments: totals.get(entry.slug) ?? 0,
    }

    let page = 1
    let hasNextPage = true

    while (hasNextPage) {
      try {
        const result = await payload.find({
          collection: entry.slug,
          depth: 0,
          fallbackLocale: false,
          limit: 50,
          locale: defaultLocale,
          overrideAccess: false,
          page,
          req,
        })

        const docs = (result.docs ?? []) as Record<string, unknown>[]
        const targets = docs
          .map((doc) => toIdentifier(doc.id) ?? toIdentifier(doc._id))
          .filter((id): id is number | string => id !== null)
          .map((id) => buildTargetKey({ collection: entry.slug, documentId: id }))
        const recordsByTarget = await fetchSyncRecords(payload, targets)

        for (const doc of docs) {
          const id = toIdentifier(doc.id) ?? toIdentifier(doc._id)
          if (id === null) {
            continue
          }

          const target = buildTargetKey({ collection: entry.slug, documentId: id })
          const document = buildStatusDocument({
            id,
            collection: entry.slug,
            doc,
            entry,
            records: recordsByTarget.get(target) ?? [],
            targetLocales,
          })

          if (emitTracking(document)) {
            outOfSync += 1
          }
          yield { type: 'document-result', document }
        }

        hasNextPage = Boolean(result.hasNextPage)
        page += 1
      } catch (error) {
        const message =
          error instanceof Error ? error.message : `Failed to scan collection ${entry.slug}.`
        yield { type: 'collection-error', collection: entry.slug, message }
        break
      }
    }
  }

  for (const entry of selectedGlobals) {
    yield {
      type: 'collection-start',
      collection: `global:${entry.slug}`,
      label: entry.label,
      totalDocuments: 1,
    }

    try {
      const doc = (await payload.findGlobal({
        slug: entry.slug,
        depth: 0,
        fallbackLocale: false,
        locale: defaultLocale,
        overrideAccess: false,
        req,
      })) as Record<string, unknown>

      const target = buildTargetKey({ global: entry.slug })
      const recordsByTarget = await fetchSyncRecords(payload, [target])
      const document = buildStatusDocument({
        doc,
        entry,
        global: entry.slug,
        records: recordsByTarget.get(target) ?? [],
        targetLocales,
      })

      if (emitTracking(document)) {
        outOfSync += 1
      }
      yield { type: 'document-result', document }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Failed to scan global ${entry.slug}.`
      yield { type: 'collection-error', collection: `global:${entry.slug}`, message }
    }
  }

  yield { type: 'scan-complete', outOfSync, processed }
}

export function createSyncStatusScanHandler(): PayloadHandler {
  return async (req) => {
    const unauthorized = rejectUnauthenticated(req)
    if (unauthorized) {
      return unauthorized
    }

    try {
      const parsed = parseScanRequest(await req.json?.())
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const event of runSyncStatusScan(req, parsed)) {
              controller.enqueue(serializeEvent(event))
              if (event.type === 'error') {
                break
              }
            }
          } catch (error) {
            controller.enqueue(
              serializeEvent({
                type: 'error',
                message: error instanceof Error ? error.message : 'Sync status scan failed.',
              }),
            )
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
      const message = error instanceof Error ? error.message : 'Invalid request body.'
      return Response.json({ message }, { status: 400 })
    }
  }
}

async function computeSingleTargetStatus(
  req: PayloadRequest,
  payload: Payload,
  input: { collection?: string; global?: string; id?: number | string },
): Promise<null | SyncStatusDocument> {
  const state = getTranslationState()
  const defaultLocale = state.defaultLocale
  const targetLocales = state.locales.filter((code) => code && code !== defaultLocale)

  if (!defaultLocale || !targetLocales.length) {
    return null
  }

  if (input.global) {
    const entry = getStoredGlobal(input.global)
    if (!entry) {
      return null
    }

    const doc = (await payload.findGlobal({
      slug: input.global,
      depth: 0,
      fallbackLocale: false,
      locale: defaultLocale,
      overrideAccess: false,
      req,
    })) as Record<string, unknown>
    const target = buildTargetKey({ global: input.global })
    const recordsByTarget = await fetchSyncRecords(payload, [target])

    return buildStatusDocument({
      doc,
      entry,
      global: input.global,
      records: recordsByTarget.get(target) ?? [],
      targetLocales,
    })
  }

  if (!input.collection || input.id == null) {
    return null
  }

  const entry = getStoredCollection(input.collection)
  if (!entry) {
    return null
  }

  const doc = (await payload.findByID({
    id: input.id,
    collection: input.collection,
    depth: 0,
    fallbackLocale: false,
    locale: defaultLocale,
    overrideAccess: false,
    req,
  })) as Record<string, unknown>
  const target = buildTargetKey({ collection: input.collection, documentId: input.id })
  const recordsByTarget = await fetchSyncRecords(payload, [target])

  return buildStatusDocument({
    id: input.id,
    collection: input.collection,
    doc,
    entry,
    records: recordsByTarget.get(target) ?? [],
    targetLocales,
  })
}

/**
 * Returns the sync status for a single document or global; used by the
 * document-level "Sync translations" button to show its out-of-sync
 * indicator.
 */
export function createSyncStatusDocumentHandler(): PayloadHandler {
  return async (req) => {
    const unauthorized = rejectUnauthenticated(req)
    if (unauthorized) {
      return unauthorized
    }

    try {
      const body = (await req.json?.()) as Record<string, unknown> | undefined
      const collection = typeof body?.collection === 'string' ? body.collection.trim() : undefined
      const global = typeof body?.global === 'string' ? body.global.trim() : undefined
      const id = toIdentifier(body?.id) ?? undefined

      if (!collection && !global) {
        return Response.json({ message: 'A collection or global is required.' }, { status: 400 })
      }

      const status = await computeSingleTargetStatus(req, req.payload, { id, collection, global })
      if (!status) {
        return Response.json({ message: 'Target is not configured for sync.' }, { status: 404 })
      }

      return Response.json({ status })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to determine sync status.'
      return Response.json({ message }, { status: 400 })
    }
  }
}
