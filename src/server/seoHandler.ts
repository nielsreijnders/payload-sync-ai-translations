import type { Payload, PayloadHandler, PayloadRequest } from 'payload'

import type { SeoScanEvent, SeoScanRequest, SeoUpdateRequest } from './seoTypes.js'

import { getValueAtPath } from '../utils/localizedFields.js'
import { scoreSeoDocument } from './seoScoring.js'
import { getSeoCollection, getSeoState } from './seoState.js'

const encoder = new TextEncoder()

function serializeEvent(event: SeoScanEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`)
}

function sanitizeCollectionSlugs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return Array.from(
    new Set(
      value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  )
}

function parseScanRequest(body: unknown): SeoScanRequest {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Invalid JSON body.')
  }

  const candidate = body as Record<string, unknown>
  const collections = sanitizeCollectionSlugs(candidate.collections)
  const state = getSeoState()
  const locale =
    typeof candidate.locale === 'string' && candidate.locale.trim()
      ? candidate.locale.trim()
      : state.defaultLocale

  if (!collections.length) {
    throw new Error('Select at least one SEO collection.')
  }
  if (!locale || !state.locales.includes(locale)) {
    throw new Error(`Unknown locale "${locale}".`)
  }

  return { collections, locale }
}

function parseUpdateRequest(body: unknown): SeoUpdateRequest {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Invalid JSON body.')
  }

  const candidate = body as Record<string, unknown>
  const collection = typeof candidate.collection === 'string' ? candidate.collection.trim() : ''
  const locale = typeof candidate.locale === 'string' ? candidate.locale.trim() : ''
  const id = candidate.id

  if (!collection || !getSeoCollection(collection)) {
    throw new Error('Unknown SEO collection.')
  }
  if (!locale || !getSeoState().locales.includes(locale)) {
    throw new Error(`Unknown locale "${locale}".`)
  }
  if (typeof id !== 'string' && typeof id !== 'number') {
    throw new Error('A valid document ID is required.')
  }
  if (typeof candidate.title !== 'string' || typeof candidate.description !== 'string') {
    throw new Error('Title and description must be strings.')
  }

  return {
    id,
    collection,
    description: candidate.description.trim(),
    locale,
    title: candidate.title.trim(),
  }
}

function setValueAtPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean)

  if (
    !segments.length ||
    segments.some((segment) => ['__proto__', 'constructor', 'prototype'].includes(segment))
  ) {
    throw new Error(`Invalid configured SEO field path "${path}".`)
  }

  let current = target
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment]
    if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
      current = existing as Record<string, unknown>
      continue
    }

    const next: Record<string, unknown> = {}
    current[segment] = next
    current = next
  }

  current[segments.at(-1) as string] = value
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value)
    } catch {
      // Fall through to JSON cloning for plain Payload data.
    }
  }

  return JSON.parse(JSON.stringify(value)) as T
}

function createUpdateData(
  existing: Record<string, unknown>,
  updates: Array<{ path: string; value: unknown }>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {}

  for (const update of updates) {
    const root = update.path.split('.')[0]?.trim()
    if (root && !(root in data) && root in existing) {
      data[root] = cloneValue(existing[root])
    }
    setValueAtPath(data, update.path, update.value)
  }

  return data
}

async function countDocuments(
  payload: Payload,
  req: PayloadRequest,
  collection: string,
): Promise<number> {
  const result = await payload.count({
    collection,
    overrideAccess: false,
    req,
  })
  return result.totalDocs
}

export async function* runSeoScan(
  req: PayloadRequest,
  request: SeoScanRequest,
): AsyncGenerator<SeoScanEvent> {
  const selected = request.collections
    .map((slug) => getSeoCollection(slug))
    .filter((entry): entry is NonNullable<ReturnType<typeof getSeoCollection>> => Boolean(entry))

  if (!selected.length) {
    yield { type: 'error', message: 'No matching SEO collections are configured.' }
    return
  }

  const totals = new Map<string, number>()
  let totalDocuments = 0

  for (const collection of selected) {
    try {
      const total = await countDocuments(req.payload, req, collection.slug)
      totals.set(collection.slug, total)
      totalDocuments += total
    } catch (error) {
      req.payload.logger.error({
        err: error,
        msg: `[AI SEO] Failed to count documents for ${collection.slug}.`,
      })
      totals.set(collection.slug, 0)
    }
  }

  yield {
    type: 'scan-start',
    totalCollections: selected.length,
    totalDocuments,
  }

  let failed = 0
  let processed = 0

  for (const collection of selected) {
    yield {
      type: 'collection-start',
      collection: collection.slug,
      label: collection.label,
      totalDocuments: totals.get(collection.slug) ?? 0,
    }

    let page = 1
    let hasNextPage = true

    while (hasNextPage) {
      try {
        const result = await req.payload.find({
          collection: collection.slug,
          depth: 0,
          fallbackLocale: false,
          limit: 50,
          locale: request.locale,
          overrideAccess: false,
          page,
          req,
        })

        for (const doc of result.docs as Record<string, unknown>[]) {
          yield {
            type: 'document-result',
            document: scoreSeoDocument(doc, collection, request.locale),
          }
          processed += 1
        }

        hasNextPage = Boolean(result.hasNextPage)
        page += 1
      } catch (error) {
        failed += 1
        const message =
          error instanceof Error ? error.message : `Failed to scan collection ${collection.slug}.`
        req.payload.logger.error({
          err: error,
          msg: `[AI SEO] ${message}`,
        })
        yield {
          type: 'collection-error',
          collection: collection.slug,
          message,
        }
        break
      }
    }
  }

  yield { type: 'scan-complete', failed, processed }
}

export function createSeoScanHandler(): PayloadHandler {
  return async (req) => {
    if (!req.user) {
      return Response.json({ message: 'Authentication required.' }, { status: 401 })
    }

    try {
      const parsed = parseScanRequest(await req.json?.())
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const event of runSeoScan(req, parsed)) {
              controller.enqueue(serializeEvent(event))
              if (event.type === 'error') {
                break
              }
            }
          } catch (error) {
            controller.enqueue(
              serializeEvent({
                type: 'error',
                message: error instanceof Error ? error.message : 'SEO scan failed.',
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

export function createSeoUpdateHandler(): PayloadHandler {
  return async (req) => {
    if (!req.user) {
      return Response.json({ message: 'Authentication required.' }, { status: 401 })
    }

    try {
      const parsed = parseUpdateRequest(await req.json?.())
      const collection = getSeoCollection(parsed.collection)
      if (!collection) {
        return Response.json({ message: 'Unknown SEO collection.' }, { status: 404 })
      }

      const existing = await req.payload.findByID({
        id: parsed.id,
        collection: parsed.collection,
        depth: 0,
        fallbackLocale: false,
        locale: parsed.locale,
        overrideAccess: false,
        req,
      })
      const data = createUpdateData(existing as Record<string, unknown>, [
        { path: collection.titlePath, value: parsed.title },
        { path: collection.descriptionPath, value: parsed.description },
      ])

      await req.payload.update({
        id: parsed.id,
        collection: parsed.collection,
        data,
        locale: parsed.locale,
        overrideAccess: false,
        req,
      })

      const updated = await req.payload.findByID({
        id: parsed.id,
        collection: parsed.collection,
        depth: 0,
        fallbackLocale: false,
        locale: parsed.locale,
        overrideAccess: false,
        req,
      })

      if (
        getValueAtPath(updated, collection.titlePath) !== parsed.title ||
        getValueAtPath(updated, collection.descriptionPath) !== parsed.description
      ) {
        req.payload.logger.warn(
          `[AI SEO] Updated ${parsed.collection}#${String(parsed.id)}, but localized metadata could not be verified.`,
        )
      }

      return Response.json({
        document: scoreSeoDocument(updated as Record<string, unknown>, collection, parsed.locale),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update SEO metadata.'
      const status =
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        typeof error.status === 'number'
          ? error.status
          : 400
      return Response.json({ message }, { status })
    }
  }
}
