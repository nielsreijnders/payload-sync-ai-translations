import type { CollectionConfig, Payload, PayloadHandler } from 'payload'

import type {
  BulkCollectionCompleteEvent,
  BulkCollectionStartEvent,
  BulkDocumentErrorEvent,
  BulkDocumentSkippedEvent,
  BulkDocumentStartEvent,
  BulkDocumentSuccessEvent,
  BulkDoneEvent,
  BulkLogEvent,
  BulkOverallProgressEvent,
  BulkStartEvent,
  BulkStreamEvent,
} from '../types/bulk.js'
import type { TranslateRequestPayload, TranslateReviewLocale } from './types.js'

import { buildTranslatableItems, type TranslatableItem } from '../components/auto-translate-button/utils/buildTranslatableItems.js'
import { type AnyField, chunkItems, collectLocalizedFieldPatterns } from '../utils/localizedFields.js'
import { runTranslationReview } from './reviewLogic.js'
import { getAllCollectionRuntimeConfigs } from './runtimeConfig.js'
import { streamTranslations } from './stream.js'

type BulkRequestBody = {
  collections: string[]
}

type LocalePlan = {
  chunks: TranslatableItem[][]
  code: string
  overrides: TranslatableItem[]
  totalItems: number
}

const encoder = new TextEncoder()

function serializeEvent(event: BulkStreamEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`)
}

function parseBody(body: unknown): BulkRequestBody {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Invalid JSON body')
  }

  const candidate = body as Record<string, unknown>
  const collections = candidate.collections

  if (!Array.isArray(collections) || !collections.length) {
    throw new Error('Select at least one collection to translate.')
  }

  const unique = Array.from(
    new Set(
      collections
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0),
    ),
  )

  if (!unique.length) {
    throw new Error('Select at least one collection to translate.')
  }

  return { collections: unique }
}

function resolveCollectionLabel(config: CollectionConfig | undefined, fallback: string): string {
  if (!config) {
    return fallback
  }

  return (
    config.labels?.plural ||
    config.labels?.singular ||
    (typeof config.label === 'string' ? config.label : undefined) ||
    fallback
  )
}

function filterFieldPatterns(patterns: string[], excludes: string[] | undefined): string[] {
  if (!excludes || !excludes.length) {
    return patterns
  }

  const normalized = excludes
    .map((entry) => entry.trim())
    .filter((entry): entry is string => entry.length > 0)
  if (!normalized.length) {
    return patterns
  }

  return patterns.filter((pattern) => {
    if (!pattern) {
      return false
    }
    const [root] = pattern.split('.')
    if (!root) {
      return true
    }
    const cleaned = root.endsWith('[]') ? root.slice(0, -2) : root
    return !normalized.includes(cleaned)
  })
}

function resolveDocumentId(doc: Record<string, unknown>): null | number | string {
  const identifier = (doc as { id?: unknown }).id ?? (doc as { _id?: unknown })._id
  if (typeof identifier === 'string' || typeof identifier === 'number') {
    return identifier
  }
  return null
}

function resolveLocaleCodes(locales: unknown, defaultLocale: string): string[] {
  if (!Array.isArray(locales)) {
    return []
  }

  return locales
    .map((locale) => {
      if (typeof locale === 'string') {
        return locale
      }
      if (typeof locale === 'object' && locale !== null) {
        const code = (locale as { code?: unknown }).code
        if (typeof code === 'string') {
          return code
        }
      }
      return null
    })
    .filter((locale): locale is string => Boolean(locale) && locale !== defaultLocale)
}

function buildLocalePlans(
  items: TranslatableItem[],
  locales: TranslateReviewLocale[],
): LocalePlan[] {
  return locales
    .map((locale) => {
      const sanitizedIndexes = Array.from(new Set(locale.translateIndexes)).filter(
        (index) => Number.isInteger(index) && index >= 0 && index < items.length,
      )

      const overrideEntries = (locale.suggestions ?? [])
        .map((suggestion) => {
          if (!Number.isInteger(suggestion.index)) {
            return null
          }
          const source = items[suggestion.index]
          if (!source) {
            return null
          }
          const text = typeof suggestion.text === 'string' ? suggestion.text.trim() : ''
          if (!text) {
            return null
          }
          return { index: suggestion.index, item: { ...source, text } }
        })
        .filter(
          (entry): entry is { index: number; item: TranslatableItem } =>
            Boolean(entry && entry.item),
        )

      const overrideIndexes = new Set(overrideEntries.map((entry) => entry.index))
      const translateItems = sanitizedIndexes
        .filter((index) => !overrideIndexes.has(index))
        .map((index) => items[index])

      const overrides = overrideEntries.map((entry) => entry.item)
      const chunks = chunkItems(translateItems)
      const totalItems = translateItems.length + overrides.length

      return { chunks, code: locale.code, overrides, totalItems }
    })
    .filter((locale) => locale.totalItems > 0)
}

async function countDocuments(payload: Payload, collection: string): Promise<number> {
  try {
    return await payload.count({ collection })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    payload.logger.error(`Failed to count documents for ${collection}: ${message}`)
    return 0
  }
}

async function* generateBulkEvents(
  payload: Payload,
  collections: string[],
): AsyncGenerator<BulkStreamEvent> {
  if (!payload.config.localization) {
    throw new Error('Localization is not configured.')
  }

  const { defaultLocale, locales } = payload.config.localization
  const otherLocales = resolveLocaleCodes(locales, defaultLocale)

  const runtimeConfigs = getAllCollectionRuntimeConfigs()

  const validCollections = collections
    .map((slug) => {
      const runtimeConfig = runtimeConfigs[slug]
      const collection = payload.collections?.[slug]
      const config = collection?.config as CollectionConfig | undefined
      const label = runtimeConfig?.label ?? resolveCollectionLabel(config, slug)
      return { slug, config, label, runtimeConfig }
    })
    .filter((entry) => Boolean(entry.config))

  if (!validCollections.length) {
    throw new Error('No valid collections to translate.')
  }

  const totals = await Promise.all(
    validCollections.map((entry) => countDocuments(payload, entry.slug)),
  )

  const totalDocuments = totals.reduce((acc, count) => acc + count, 0)

  yield <BulkStartEvent>{
    type: 'start',
    totalCollections: validCollections.length,
    totalDocuments,
  }

  let overallTranslated = 0
  let overallFailed = 0
  let overallSkipped = 0

  for (let collIndex = 0; collIndex < validCollections.length; collIndex += 1) {
    const { slug, config, label, runtimeConfig } = validCollections[collIndex]
    const totalForCollection = totals[collIndex]

    yield <BulkCollectionStartEvent>{
      type: 'collection-start',
      collection: slug,
      label,
      totalDocuments: totalForCollection,
    }

    const startMessage = `Starting bulk translation for ${label} (${slug})`
    payload.logger.info(startMessage)
    yield <BulkLogEvent>{ type: 'log', level: 'info', message: startMessage }

    const fields = (config?.fields ?? []) as AnyField[]
    const rawPatterns = collectLocalizedFieldPatterns(fields)
    const patterns = filterFieldPatterns(rawPatterns, runtimeConfig?.options.excludeFields)

    const limit = 50
    let page = 1
    let processed = 0
    let failed = 0
    let skipped = 0
    let hasMore = true

    while (hasMore) {
      let results: unknown
      try {
        results = await payload.find({
          collection: slug,
          depth: 0,
          fallbackLocale: false,
          limit,
          locale: defaultLocale,
          page,
        })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to load documents for translation.'
        const logMessage = `[AI Bulk] ${label} (${slug}) failed to load documents: ${message}`
        payload.logger.error(logMessage)
        yield <BulkLogEvent>{ type: 'log', level: 'error', message: logMessage }
        break
      }

      const docs = Array.isArray((results as { docs?: unknown }).docs)
        ? ((results as { docs: unknown[] }).docs as Record<string, unknown>[])
        : []

      for (const doc of docs) {
        const identifier = resolveDocumentId(doc)
        const docId = identifier ?? `${slug}-${processed + failed + skipped + 1}`
        yield <BulkDocumentStartEvent>{ id: String(docId), type: 'document-start', collection: slug, label }

        if (identifier === null) {
          const message = 'Document identifier could not be resolved.'
          const logMessage = `[AI Bulk] ${label} (${slug}) missing identifier.`
          payload.logger.error(logMessage)
          failed += 1
          overallFailed += 1
          yield <BulkLogEvent>{ type: 'log', level: 'error', message: logMessage }
          yield <BulkDocumentErrorEvent>{
            id: String(docId),
            type: 'document-error',
            collection: slug,
            message,
          }
          const handled = overallTranslated + overallSkipped + overallFailed
          yield <BulkOverallProgressEvent>{
            type: 'overall-progress',
            processed: handled,
            total: totalDocuments,
          }
          continue
        }

        const items = buildTranslatableItems(doc, patterns)
        if (!items.length) {
          const reason = 'No translatable fields found.'
          const message = `[AI Bulk] ${label} (${slug}) #${docId} skipped: ${reason}`
          payload.logger.info(message)
          skipped += 1
          overallSkipped += 1
          yield <BulkLogEvent>{ type: 'log', level: 'info', message }
          yield <BulkDocumentSkippedEvent>{
            id: String(docId),
            type: 'document-skipped',
            collection: slug,
            reason,
          }
          const handled = overallTranslated + overallSkipped + overallFailed
          yield <BulkOverallProgressEvent>{
            type: 'overall-progress',
            processed: handled,
            total: totalDocuments,
          }
          continue
        }

        const reviewRequest = {
          id: identifier,
          collection: slug,
          from: defaultLocale,
          items,
          locales: otherLocales,
        }

        try {
          const review = await runTranslationReview(payload, reviewRequest)

          const requiresReview = review.locales.some(
            (locale) => (locale.mismatches?.length ?? 0) > 0 && locale.existingCount > 0,
          )

          if (requiresReview) {
            const reason = 'Manual review required due to conflicting translations.'
            const message = `[AI Bulk] ${label} (${slug}) #${docId} requires manual review.`
            payload.logger.info(message)
            skipped += 1
            overallSkipped += 1
            yield <BulkLogEvent>{ type: 'log', level: 'info', message }
            yield <BulkDocumentSkippedEvent>{
              id: String(docId),
              type: 'document-skipped',
              collection: slug,
              reason,
            }
            const handled = overallTranslated + overallSkipped + overallFailed
            yield <BulkOverallProgressEvent>{
              type: 'overall-progress',
              processed: handled,
              total: totalDocuments,
            }
            continue
          }

          const localePlans = buildLocalePlans(items, review.locales)

          if (!localePlans.length) {
            const reason = 'Translations are already up-to-date.'
            const message = `[AI Bulk] ${label} (${slug}) #${docId} skipped: ${reason}`
            payload.logger.info(message)
            skipped += 1
            overallSkipped += 1
            yield <BulkLogEvent>{ type: 'log', level: 'info', message }
            yield <BulkDocumentSkippedEvent>{
              id: String(docId),
              type: 'document-skipped',
              collection: slug,
              reason,
            }
            const handled = overallTranslated + overallSkipped + overallFailed
            yield <BulkOverallProgressEvent>{
              type: 'overall-progress',
              processed: handled,
              total: totalDocuments,
            }
            continue
          }

          const translationPayload: TranslateRequestPayload = {
            id: identifier,
            collection: slug,
            from: defaultLocale,
            locales: localePlans.map((plan) => ({
              chunks: plan.chunks,
              code: plan.code,
              overrides: plan.overrides,
            })),
          }

          let documentFailed = false

          for await (const event of streamTranslations(payload, translationPayload)) {
            if (event.type === 'progress') {
              yield <BulkDocumentProgressEvent>{
                id: String(docId),
                type: 'document-progress',
                collection: slug,
                completed: event.completed,
                locale: event.locale,
                total: event.total,
              }
            } else if (event.type === 'error') {
              const message = event.message || 'Translation failed.'
              const logMessage = `[AI Bulk] ${label} (${slug}) #${docId} failed: ${message}`
              payload.logger.error(logMessage)
              yield <BulkLogEvent>{ type: 'log', level: 'error', message: logMessage }
              yield <BulkDocumentErrorEvent>{
                id: String(docId),
                type: 'document-error',
                collection: slug,
                message,
              }
              documentFailed = true
              break
            } else if (event.type === 'applied') {
              const message = `[AI Bulk] ${label} (${slug}) #${docId} saved locale ${event.locale}.`
              payload.logger.info(message)
              yield <BulkLogEvent>{ type: 'log', level: 'info', message }
            } else if (event.type === 'done') {
              break
            }
          }

          if (documentFailed) {
            failed += 1
            overallFailed += 1
          } else {
            processed += 1
            overallTranslated += 1
            const message = `[AI Bulk] ${label} (${slug}) #${docId} translated successfully.`
            payload.logger.info(message)
            yield <BulkLogEvent>{ type: 'log', level: 'info', message }
            yield <BulkDocumentSuccessEvent>{
              id: String(docId),
              type: 'document-success',
              collection: slug,
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Translation failed.'
          const logMessage = `[AI Bulk] ${label} (${slug}) #${docId} failed: ${message}`
          payload.logger.error(logMessage)
          failed += 1
          overallFailed += 1
          yield <BulkLogEvent>{ type: 'log', level: 'error', message: logMessage }
          yield <BulkDocumentErrorEvent>{
            id: String(docId),
            type: 'document-error',
            collection: slug,
            message,
          }
        }

        yield <BulkOverallProgressEvent>{
          type: 'overall-progress',
          processed: overallTranslated + overallSkipped + overallFailed,
          total: totalDocuments,
        }
      }

      const totalPages = Number((results as { totalPages?: unknown }).totalPages) || 1
      page += 1
      hasMore = page <= totalPages
    }

    yield <BulkCollectionCompleteEvent>{
      type: 'collection-complete',
      collection: slug,
      failed,
      label,
      processed,
      skipped,
    }

    const summaryMessage =
      processed + failed + skipped === 0
        ? `No documents processed for ${label} (${slug}).`
        : `Finished bulk translation for ${label} (${slug}): ${processed} success, ${failed} failed, ${skipped} skipped.`
    payload.logger.info(summaryMessage)
    yield <BulkLogEvent>{ type: 'log', level: 'info', message: summaryMessage }
  }

  yield <BulkDoneEvent>{
    type: 'done',
    failed: overallFailed,
    processed: overallTranslated,
    skipped: overallSkipped,
  }
}

export function createBulkTranslateHandler(): PayloadHandler {
  return async (req) => {
    try {
      const payload = req.payload
      if (!payload) {
        throw new Error('Payload instance is not available on the request')
      }

      const parsed = parseBody(await req.json())

      const stream = new ReadableStream({
        async start(controller) {
          try {
            for await (const event of generateBulkEvents(payload, parsed.collections)) {
              controller.enqueue(serializeEvent(event))
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Bulk translation failed.'
            const errorEvent: BulkLogEvent = { type: 'log', level: 'error', message }
            controller.enqueue(serializeEvent(errorEvent))
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
