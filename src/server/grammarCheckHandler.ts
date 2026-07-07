import type { Payload, PayloadHandler } from 'payload'

import type { TranslatableItem } from '../components/auto-translate-button/utils/buildTranslatableItems.js'
import type {
  BulkGrammarCheckRequestPayload,
  BulkStreamEvent,
  TranslateOverride,
} from './translationTypes.js'

import { chunkItems } from '../utils/localizedFields.js'
import { runApplyFromTargets } from './bulkApplyRunner.js'
import { parseApplyTargets, sanitizeSlugArray, serializeBulkEvent } from './bulkRequestParsing.js'
import { resolveCustomPrompt } from './customPrompt.js'
import { logDebug } from './debugSettings.js'
import { openAiProofreadTexts } from './openAiTranslationClient.js'
import { rejectUnauthenticated } from './requireUser.js'
import { buildTextCandidates } from './textCandidates.js'
import {
  getStoredCollection,
  getStoredGlobal,
  getTranslationState,
} from './translationStateStore.js'
import { streamTranslations } from './translationStream.js'

type StoredCollectionEntry = NonNullable<ReturnType<typeof getStoredCollection>>
type StoredGlobalEntry = NonNullable<ReturnType<typeof getStoredGlobal>>
type TypoOverride = {
  before: string
} & TranslatableItem

function parseBulkGrammarBody(body: unknown): BulkGrammarCheckRequestPayload {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Invalid JSON body')
  }

  const candidate = body as Record<string, unknown>
  const apply = candidate.apply
  const applyTargets = parseApplyTargets(candidate.applyTargets)
  const collections = sanitizeSlugArray(candidate.collections)
  const globals = sanitizeSlugArray(candidate.globals)

  if (!collections.length && !globals.length) {
    throw new Error('No collections or globals selected for grammar check')
  }

  if (apply !== undefined && typeof apply !== 'boolean') {
    throw new Error('Expected "apply" to be a boolean')
  }

  return {
    apply: Boolean(apply),
    applyTargets,
    collections,
    globals,
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function stripTrailingSentencePunctuation(value: string): string {
  return value.replace(/[.!?…]+$/u, '').trimEnd()
}

function isLabelLikePath(path: string): boolean {
  const segments = path
    .split('.')
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean)

  if (!segments.length) {
    return false
  }

  const last = segments.at(-1)
  return last === 'label'
}

function isTrailingPunctuationOnlyChange(before: string, after: string): boolean {
  const normalizedBefore = normalizeWhitespace(before)
  const normalizedAfter = normalizeWhitespace(after)

  if (!normalizedBefore || !normalizedAfter || normalizedBefore === normalizedAfter) {
    return false
  }

  return (
    stripTrailingSentencePunctuation(normalizedBefore) ===
    stripTrailingSentencePunctuation(normalizedAfter)
  )
}

async function buildTypoOverrides(
  items: TranslatableItem[],
  locale: string,
  customPrompt?: string,
): Promise<TypoOverride[]> {
  if (!items.length) {
    return []
  }

  const overrides: TypoOverride[] = []

  for (const chunk of chunkItems(items)) {
    const corrected = await openAiProofreadTexts(
      chunk.map((item) => item.text),
      locale,
      {
        customPrompt,
      },
    )

    for (let index = 0; index < chunk.length; index += 1) {
      const source = chunk[index]
      const next = corrected[index] ?? ''

      if (!next.trim() || next === source.text) {
        continue
      }

      // Button/link labels often should stay punctuation-free; ignore punctuation-only deltas.
      if (isLabelLikePath(source.path) && isTrailingPunctuationOnlyChange(source.text, next)) {
        continue
      }

      overrides.push({
        ...source,
        before: source.text,
        text: next,
      })
    }
  }

  return overrides
}

function toCollectionLabel(slug: string): string {
  return slug
}

function toGlobalLabel(slug: string): string {
  return `global:${slug}`
}

function asApplyOverrides(overrides: TypoOverride[]): TranslateOverride[] {
  return overrides.map((override) => ({
    lexical: override.lexical,
    path: override.path,
    text: override.text,
  }))
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

async function* runBulkGrammarCheck(
  payload: Payload,
  request: BulkGrammarCheckRequestPayload,
): AsyncGenerator<BulkStreamEvent> {
  const state = getTranslationState()
  const defaultLocale = state.defaultLocale

  if (!defaultLocale) {
    yield { type: 'error', message: 'Default locale is not configured for grammar check.' }
    return
  }

  const selectedCollections = request.collections
    .map((slug) => getStoredCollection(slug))
    .filter((entry): entry is StoredCollectionEntry => Boolean(entry))
  const selectedGlobals = (request.globals ?? [])
    .map((slug) => getStoredGlobal(slug))
    .filter((entry): entry is StoredGlobalEntry => Boolean(entry))

  if (!selectedCollections.length && !selectedGlobals.length) {
    yield {
      type: 'error',
      message: 'No matching collections or globals configured for grammar check.',
    }
    return
  }

  const selectedCollectionsBySlug = new Map(selectedCollections.map((entry) => [entry.slug, entry]))
  const selectedGlobalsBySlug = new Map(selectedGlobals.map((entry) => [entry.slug, entry]))

  logDebug(payload, '[AI Grammar] Bulk grammar check targets resolved.', {
    defaultLocale,
    mode: request.apply ? 'apply' : 'scan',
    requestedCollections: request.collections,
    requestedGlobals: request.globals ?? [],
    resolvedCollections: selectedCollections.map((entry) => ({
      slug: entry.slug,
      fieldPatterns: entry.fieldPatterns,
      label: entry.label,
    })),
    resolvedGlobals: selectedGlobals.map((entry) => ({
      slug: entry.slug,
      fieldPatterns: entry.fieldPatterns,
      label: entry.label,
    })),
  })

  if (request.apply && (request.applyTargets?.length ?? 0) > 0) {
    yield* runApplyFromTargets(payload, {
      applyTargets: request.applyTargets ?? [],
      locale: defaultLocale,
      noOverridesReason: 'No typo corrections available for this target.',
      selectedCollectionsBySlug,
      selectedGlobalsBySlug,
    })
    return
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
      payload.logger?.error?.(`[AI Grammar] ${message}`)
      totals.set(entry.slug, 0)
    }
  }

  for (const entry of selectedGlobals) {
    totals.set(toGlobalLabel(entry.slug), 1)
    grandTotal += 1
  }

  yield {
    type: 'bulk-start',
    totalCollections: selectedCollections.length + selectedGlobals.length,
    totalDocuments: grandTotal,
  }

  let overallProcessed = 0
  let overallSkipped = 0
  let overallFailed = 0

  for (const entry of selectedCollections) {
    const totalForCollection = totals.get(entry.slug) ?? 0
    let collectionProcessed = 0
    let collectionSkipped = 0
    let collectionFailed = 0

    yield {
      type: 'collection-start',
      collection: toCollectionLabel(entry.slug),
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
        yield {
          id: `${entry.slug}-page-${page}`,
          type: 'document-error',
          collection: toCollectionLabel(entry.slug),
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
            collection: toCollectionLabel(entry.slug),
            reason: 'Document is missing an identifier.',
          }
          continue
        }

        const docLabel = String(docIdentifier)
        const eventCollection = toCollectionLabel(entry.slug)
        yield { id: docLabel, type: 'document-start', collection: eventCollection }

        const { identifierPaths, items } = buildTextCandidates(doc, entry.fieldPatterns)

        if (!items.length) {
          collectionSkipped += 1
          overallSkipped += 1
          yield {
            id: docLabel,
            type: 'document-skipped',
            collection: eventCollection,
            reason: 'No translatable fields found.',
          }
          continue
        }

        const grammarPrompt = resolveCustomPrompt(payload, entry.grammarCheckPrompt, doc, {
          collection: entry.slug,
          documentId: docIdentifier,
          locale: defaultLocale,
        })

        let overrides: TypoOverride[] = []
        try {
          overrides = await buildTypoOverrides(items, defaultLocale, grammarPrompt)
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : 'Failed to scan document for grammar corrections.'
          collectionFailed += 1
          overallFailed += 1
          yield { id: docLabel, type: 'document-error', collection: eventCollection, message }
          continue
        }

        if (!overrides.length) {
          collectionSkipped += 1
          overallSkipped += 1
          yield {
            id: docLabel,
            type: 'document-skipped',
            collection: eventCollection,
            reason: 'No typo corrections detected.',
          }
          continue
        }

        yield {
          id: docLabel,
          type: 'document-fixes',
          collection: eventCollection,
          fixes: overrides.map((override) => ({
            after: override.text,
            before: override.before,
            lexical: override.lexical,
            path: override.path,
          })),
        }

        const applyOverrides = asApplyOverrides(overrides)

        if (!request.apply) {
          collectionProcessed += 1
          overallProcessed += 1
          yield { id: docLabel, type: 'document-success', collection: eventCollection }
          continue
        }

        let hadError = false

        for await (const event of streamTranslations(payload, {
          id: docIdentifier,
          collection: entry.slug,
          from: defaultLocale,
          locales: [
            {
              chunks: [],
              code: defaultLocale,
              identifierPaths,
              overrides: applyOverrides,
            },
          ],
        })) {
          switch (event.type) {
            case 'applied':
              yield {
                id: docLabel,
                type: 'document-applied',
                collection: eventCollection,
                locale: event.locale,
              }
              break
            case 'done':
              break
            case 'error':
              hadError = true
              collectionFailed += 1
              overallFailed += 1
              yield {
                id: docLabel,
                type: 'document-error',
                collection: eventCollection,
                message: event.message,
              }
              break
            case 'progress':
              yield {
                id: docLabel,
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

        if (hadError) {
          continue
        }

        collectionProcessed += 1
        overallProcessed += 1
        yield { id: docLabel, type: 'document-success', collection: eventCollection }
      }
    }

    yield {
      type: 'collection-complete',
      collection: toCollectionLabel(entry.slug),
      failed: collectionFailed,
      processed: collectionProcessed,
      skipped: collectionSkipped,
    }
  }

  for (const entry of selectedGlobals) {
    const eventCollection = toGlobalLabel(entry.slug)
    let collectionProcessed = 0
    let collectionSkipped = 0
    let collectionFailed = 0

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
        locale: defaultLocale,
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Failed to load global ${entry.slug}.`
      collectionFailed += 1
      overallFailed += 1
      yield { id: entry.slug, type: 'document-error', collection: eventCollection, message }
      yield {
        type: 'collection-complete',
        collection: eventCollection,
        failed: collectionFailed,
        processed: collectionProcessed,
        skipped: collectionSkipped,
      }
      continue
    }

    yield { id: entry.slug, type: 'document-start', collection: eventCollection }

    const { identifierPaths, items } = buildTextCandidates(globalDoc, entry.fieldPatterns)

    if (!items.length) {
      collectionSkipped += 1
      overallSkipped += 1
      yield {
        id: entry.slug,
        type: 'document-skipped',
        collection: eventCollection,
        reason: 'No translatable fields found.',
      }
      yield {
        type: 'collection-complete',
        collection: eventCollection,
        failed: collectionFailed,
        processed: collectionProcessed,
        skipped: collectionSkipped,
      }
      continue
    }

    const grammarPrompt = resolveCustomPrompt(payload, entry.grammarCheckPrompt, globalDoc, {
      collection: eventCollection,
      documentId: entry.slug,
      locale: defaultLocale,
    })

    let overrides: TypoOverride[] = []

    try {
      overrides = await buildTypoOverrides(items, defaultLocale, grammarPrompt)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to scan global for grammar corrections.'
      collectionFailed += 1
      overallFailed += 1
      yield { id: entry.slug, type: 'document-error', collection: eventCollection, message }
      yield {
        type: 'collection-complete',
        collection: eventCollection,
        failed: collectionFailed,
        processed: collectionProcessed,
        skipped: collectionSkipped,
      }
      continue
    }

    if (!overrides.length) {
      collectionSkipped += 1
      overallSkipped += 1
      yield {
        id: entry.slug,
        type: 'document-skipped',
        collection: eventCollection,
        reason: 'No typo corrections detected.',
      }
      yield {
        type: 'collection-complete',
        collection: eventCollection,
        failed: collectionFailed,
        processed: collectionProcessed,
        skipped: collectionSkipped,
      }
      continue
    }

    yield {
      id: entry.slug,
      type: 'document-fixes',
      collection: eventCollection,
      fixes: overrides.map((override) => ({
        after: override.text,
        before: override.before,
        lexical: override.lexical,
        path: override.path,
      })),
      global: entry.slug,
    }

    const applyOverrides = asApplyOverrides(overrides)

    if (!request.apply) {
      collectionProcessed += 1
      overallProcessed += 1
      yield { id: entry.slug, type: 'document-success', collection: eventCollection }
      yield {
        type: 'collection-complete',
        collection: eventCollection,
        failed: collectionFailed,
        processed: collectionProcessed,
        skipped: collectionSkipped,
      }
      continue
    }

    let hadError = false

    for await (const event of streamTranslations(payload, {
      from: defaultLocale,
      global: entry.slug,
      locales: [
        {
          chunks: [],
          code: defaultLocale,
          identifierPaths,
          overrides: applyOverrides,
        },
      ],
    })) {
      switch (event.type) {
        case 'applied':
          yield {
            id: entry.slug,
            type: 'document-applied',
            collection: eventCollection,
            locale: event.locale,
          }
          break
        case 'done':
          break
        case 'error':
          hadError = true
          collectionFailed += 1
          overallFailed += 1
          yield {
            id: entry.slug,
            type: 'document-error',
            collection: eventCollection,
            message: event.message,
          }
          break
        case 'progress':
          yield {
            id: entry.slug,
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

    if (!hadError) {
      collectionProcessed += 1
      overallProcessed += 1
      yield { id: entry.slug, type: 'document-success', collection: eventCollection }
    }

    yield {
      type: 'collection-complete',
      collection: eventCollection,
      failed: collectionFailed,
      processed: collectionProcessed,
      skipped: collectionSkipped,
    }
  }

  yield {
    type: 'bulk-complete',
    failed: overallFailed,
    processed: overallProcessed,
    skipped: overallSkipped,
  }
}

export function createAiGrammarCheckHandler(): PayloadHandler {
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
      const parsed = parseBulkGrammarBody(await req.json())

      logDebug(payload, '[AI Grammar] Parsed bulk grammar check request.', {
        apply: parsed.apply,
        applyTargets: parsed.applyTargets?.length ?? 0,
        collections: parsed.collections,
        globals: parsed.globals ?? [],
      })

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const event of runBulkGrammarCheck(payload, parsed)) {
              controller.enqueue(serializeBulkEvent(event))
              if (event.type === 'error') {
                break
              }
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : 'Failed to run bulk grammar check.'
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
