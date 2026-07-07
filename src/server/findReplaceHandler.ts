import type { Payload, PayloadHandler } from 'payload'

import type { TranslatableItem } from '../components/auto-translate-button/utils/buildTranslatableItems.js'
import type { BulkFindReplaceRequestPayload, BulkStreamEvent } from './translationTypes.js'

import { replaceLexicalSegments } from '../utils/lexical.js'
import { runApplyFromTargets } from './bulkApplyRunner.js'
import { parseApplyTargets, sanitizeSlugArray, serializeBulkEvent } from './bulkRequestParsing.js'
import { logDebug } from './debugSettings.js'
import { rejectUnauthenticated } from './requireUser.js'
import { buildTextCandidates } from './textCandidates.js'
import {
  getStoredCollection,
  getStoredGlobal,
  getTranslationState,
} from './translationStateStore.js'

type StoredCollectionEntry = NonNullable<ReturnType<typeof getStoredCollection>>
type StoredGlobalEntry = NonNullable<ReturnType<typeof getStoredGlobal>>

type ReplacementFix = {
  after: string
  before: string
  lexical: boolean
  path: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function buildFindRegex(
  find: string,
  options: { caseSensitive: boolean; wholeWord: boolean },
): RegExp {
  const escaped = escapeRegExp(find)
  const source = options.wholeWord
    ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`
    : escaped

  return new RegExp(source, options.caseSensitive ? 'gu' : 'giu')
}

/**
 * Replaces every match in an item's text. Lexical items are replaced per
 * marker segment so the `[[LEX-n]]` tokens stay intact; plain strings are
 * replaced directly. The replacement string is always treated literally.
 */
export function applyReplacementToItem(
  item: TranslatableItem,
  regex: RegExp,
  replacement: string,
): string {
  const replaceAll = (value: string) => value.replace(regex, () => replacement)

  if (item.lexical) {
    return replaceLexicalSegments(item.text, replaceAll)
  }

  return replaceAll(item.text)
}

export function buildReplacementFixes(
  items: TranslatableItem[],
  find: string,
  replacement: string,
  options: { caseSensitive: boolean; wholeWord: boolean },
): ReplacementFix[] {
  const regex = buildFindRegex(find, options)
  const fixes: ReplacementFix[] = []

  for (const item of items) {
    const after = applyReplacementToItem(item, regex, replacement)

    if (after === item.text) {
      continue
    }

    // The override pipeline cannot write empty values; skip replacements that
    // would blank a field entirely.
    if (!after.trim()) {
      continue
    }

    fixes.push({
      after,
      before: item.text,
      lexical: item.lexical,
      path: item.path,
    })
  }

  return fixes
}

function parseBulkFindReplaceBody(body: unknown): BulkFindReplaceRequestPayload {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Invalid JSON body')
  }

  const candidate = body as Record<string, unknown>
  const apply = candidate.apply
  const applyTargets = parseApplyTargets(candidate.applyTargets)
  const collections = sanitizeSlugArray(candidate.collections)
  const globals = sanitizeSlugArray(candidate.globals)
  const find = typeof candidate.find === 'string' ? candidate.find : ''
  const replace = typeof candidate.replace === 'string' ? candidate.replace : ''
  const locale =
    typeof candidate.locale === 'string' && candidate.locale.trim()
      ? candidate.locale.trim()
      : undefined

  if (!collections.length && !globals.length) {
    throw new Error('No collections or globals selected for find & replace')
  }

  if (!find.trim()) {
    throw new Error('Expected "find" to be a non-empty string')
  }

  if (apply !== undefined && typeof apply !== 'boolean') {
    throw new Error('Expected "apply" to be a boolean')
  }

  return {
    apply: Boolean(apply),
    applyTargets,
    caseSensitive: Boolean(candidate.caseSensitive),
    collections,
    find,
    globals,
    locale,
    replace,
    wholeWord: Boolean(candidate.wholeWord),
  }
}

function toGlobalLabel(slug: string): string {
  return `global:${slug}`
}

function toIdentifier(value: unknown): null | number | string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length ? trimmed : null
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  return null
}

async function* runBulkFindReplace(
  payload: Payload,
  request: BulkFindReplaceRequestPayload,
): AsyncGenerator<BulkStreamEvent> {
  const state = getTranslationState()
  const defaultLocale = state.defaultLocale

  if (!defaultLocale) {
    yield { type: 'error', message: 'Default locale is not configured for find & replace.' }
    return
  }

  const locale =
    request.locale && state.locales.includes(request.locale) ? request.locale : defaultLocale

  const selectedCollections = request.collections
    .map((slug) => getStoredCollection(slug))
    .filter((entry): entry is StoredCollectionEntry => Boolean(entry))
  const selectedGlobals = (request.globals ?? [])
    .map((slug) => getStoredGlobal(slug))
    .filter((entry): entry is StoredGlobalEntry => Boolean(entry))

  if (!selectedCollections.length && !selectedGlobals.length) {
    yield {
      type: 'error',
      message: 'No matching collections or globals configured for find & replace.',
    }
    return
  }

  logDebug(payload, '[AI Find & Replace] Bulk request resolved.', {
    caseSensitive: request.caseSensitive,
    find: request.find,
    locale,
    mode: request.apply ? 'apply' : 'scan',
    replace: request.replace,
    requestedCollections: request.collections,
    requestedGlobals: request.globals ?? [],
    wholeWord: request.wholeWord,
  })

  if (request.apply && (request.applyTargets?.length ?? 0) > 0) {
    yield* runApplyFromTargets(payload, {
      applyTargets: request.applyTargets ?? [],
      locale,
      noOverridesReason: 'No replacements available for this target.',
      selectedCollectionsBySlug: new Map(selectedCollections.map((entry) => [entry.slug, entry])),
      selectedGlobalsBySlug: new Map(selectedGlobals.map((entry) => [entry.slug, entry])),
    })
    return
  }

  const replacementOptions = {
    caseSensitive: request.caseSensitive,
    wholeWord: request.wholeWord,
  }

  const totals = new Map<string, number>()
  let grandTotal = 0

  for (const entry of selectedCollections) {
    try {
      const result = await payload.find({
        collection: entry.slug,
        depth: 0,
        fallbackLocale: false,
        limit: 1,
        locale,
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
      payload.logger?.error?.(`[AI Find & Replace] ${message}`)
      totals.set(entry.slug, 0)
    }
  }

  grandTotal += selectedGlobals.length

  yield {
    type: 'bulk-start',
    totalCollections: selectedCollections.length + selectedGlobals.length,
    totalDocuments: grandTotal,
  }

  let overallProcessed = 0
  let overallSkipped = 0
  let overallFailed = 0

  for (const entry of selectedCollections) {
    let collectionProcessed = 0
    let collectionSkipped = 0
    let collectionFailed = 0

    yield {
      type: 'collection-start',
      collection: entry.slug,
      label: entry.label,
      totalDocuments: totals.get(entry.slug) ?? 0,
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
          locale,
          page,
        })
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : `Failed to fetch documents for collection ${entry.slug}.`
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
          yield {
            id: 'unknown',
            type: 'document-skipped',
            collection: entry.slug,
            reason: 'Document is missing an identifier.',
          }
          continue
        }

        const docLabel = String(docIdentifier)
        yield { id: docLabel, type: 'document-start', collection: entry.slug }

        const { items } = buildTextCandidates(doc, entry.fieldPatterns)
        const fixes = buildReplacementFixes(items, request.find, request.replace, replacementOptions)

        if (!fixes.length) {
          collectionSkipped += 1
          overallSkipped += 1
          yield {
            id: docLabel,
            type: 'document-skipped',
            collection: entry.slug,
            reason: 'No matches found.',
          }
          continue
        }

        yield {
          id: docLabel,
          type: 'document-fixes',
          collection: entry.slug,
          fixes,
        }

        collectionProcessed += 1
        overallProcessed += 1
        yield { id: docLabel, type: 'document-success', collection: entry.slug }
      }
    }

    yield {
      type: 'collection-complete',
      collection: entry.slug,
      failed: collectionFailed,
      processed: collectionProcessed,
      skipped: collectionSkipped,
    }
  }

  for (const entry of selectedGlobals) {
    const eventCollection = toGlobalLabel(entry.slug)
    let processed = 0
    let skipped = 0
    let failed = 0

    yield {
      type: 'collection-start',
      collection: eventCollection,
      label: entry.label,
      totalDocuments: 1,
    }

    let globalDoc: unknown

    try {
      globalDoc = await payload.findGlobal({
        slug: entry.slug,
        depth: 0,
        fallbackLocale: false,
        locale,
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Failed to load global ${entry.slug}.`
      failed += 1
      overallFailed += 1
      yield { id: entry.slug, type: 'document-error', collection: eventCollection, message }
      yield {
        type: 'collection-complete',
        collection: eventCollection,
        failed,
        processed,
        skipped,
      }
      continue
    }

    yield { id: entry.slug, type: 'document-start', collection: eventCollection }

    const { items } = buildTextCandidates(globalDoc, entry.fieldPatterns)
    const fixes = buildReplacementFixes(items, request.find, request.replace, replacementOptions)

    if (!fixes.length) {
      skipped += 1
      overallSkipped += 1
      yield {
        id: entry.slug,
        type: 'document-skipped',
        collection: eventCollection,
        reason: 'No matches found.',
      }
    } else {
      yield {
        id: entry.slug,
        type: 'document-fixes',
        collection: eventCollection,
        fixes,
        global: entry.slug,
      }

      processed += 1
      overallProcessed += 1
      yield { id: entry.slug, type: 'document-success', collection: eventCollection }
    }

    yield {
      type: 'collection-complete',
      collection: eventCollection,
      failed,
      processed,
      skipped,
    }
  }

  yield {
    type: 'bulk-complete',
    failed: overallFailed,
    processed: overallProcessed,
    skipped: overallSkipped,
  }
}

export function createFindReplaceHandler(): PayloadHandler {
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
      const parsed = parseBulkFindReplaceBody(await req.json())

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const event of runBulkFindReplace(payload, parsed)) {
              controller.enqueue(serializeBulkEvent(event))
              if (event.type === 'error') {
                break
              }
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : 'Failed to run find & replace.'
            controller.enqueue(serializeBulkEvent({ type: 'error', message }))
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
