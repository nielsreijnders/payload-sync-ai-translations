import type { PayloadHandler } from 'payload'

import type {
  BulkTranslateLogLevel,
  BulkTranslateStreamEvent,
  TranslateRequestPayload,
  TranslateReviewLocale,
} from './types.js'

import {
  buildTranslatableItems,
  type TranslatableItem,
} from '../utils/buildTranslatableItems.js'
import { chunkItems, collectLocalizedFieldPatterns } from '../utils/localizedFields.js'
import { generateTranslationReview } from './reviewPlan.js'
import { streamTranslations } from './stream.js'

type BulkHandlerOptions = {
  bulkGlobalSlug: string
  collectionLabels: Record<string, string>
  collectionOptions: Record<string, { excludeFields?: string[] }>
}

type LocaleTranslationSelection = {
  code: string
  overrides: TranslatableItem[]
  translateIndexes: number[]
}

const encoder = new TextEncoder()

function serializeEvent(event: BulkTranslateStreamEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`)
}

function appendLog(
  controller: ReadableStreamDefaultController<Uint8Array>,
  level: BulkTranslateLogLevel,
  message: string,
) {
  controller.enqueue(serializeEvent({ type: 'log', level, message }))
}

function buildLocaleSelections(
  locales: TranslateReviewLocale[],
  items: TranslatableItem[],
): LocaleTranslationSelection[] {
  return locales
    .map((locale) => {
      const overrideEntries = new Map<number, string>()
      for (const suggestion of locale.suggestions ?? []) {
        if (!Number.isInteger(suggestion.index)) {
          continue
        }

        const trimmed = typeof suggestion.text === 'string' ? suggestion.text.trim() : ''
        if (!trimmed) {
          continue
        }

        if (!overrideEntries.has(suggestion.index)) {
          overrideEntries.set(suggestion.index, trimmed)
        }
      }

      const overrides: TranslatableItem[] = []
      const overrideIndexes = new Set<number>()

      for (const [index, text] of overrideEntries) {
        const item = items[index]
        if (!item) {
          continue
        }

        overrideIndexes.add(index)
        overrides.push({ ...item, text })
      }

      const translateIndexes = Array.from(new Set(locale.translateIndexes))
        .filter((index) => Number.isInteger(index) && index >= 0 && index < items.length)
        .filter((index) => !overrideIndexes.has(index))

      if (!translateIndexes.length && !overrides.length) {
        return null
      }

      return { code: locale.code, overrides, translateIndexes }
    })
    .filter((entry): entry is LocaleTranslationSelection => Boolean(entry))
}

function normalizeLocaleCode(value: unknown): null | string {
  if (typeof value === 'string') {
    return value
  }

  if (value && typeof value === 'object' && typeof (value as { code?: unknown }).code === 'string') {
    const code = (value as { code: string }).code
    return code || null
  }

  return null
}

function hasToString(value: unknown): value is { toString(): string } {
  return Boolean(value && typeof (value as { toString?: unknown }).toString === 'function')
}

export function createAiBulkTranslateHandler(options: BulkHandlerOptions): PayloadHandler {
  return async (req) => {
    const payload = req.payload
    if (!payload) {
      return Response.json({ type: 'error', message: 'Payload instance not available.' }, { status: 500 })
    }

    const localization = payload.config?.localization
    const defaultLocale = localization?.defaultLocale
    const configuredLocales = localization?.locales ?? []

    if (!defaultLocale) {
      return Response.json({ type: 'error', message: 'Localization is not configured.' }, { status: 500 })
    }

    const otherLocales = configuredLocales
      .map((locale) => normalizeLocaleCode(locale))
      .filter((code): code is string => Boolean(code && code !== defaultLocale))

    if (!otherLocales.length) {
      return Response.json({ type: 'error', message: 'No target locales configured.' }, { status: 500 })
    }

    let body: Record<string, unknown> = {}
    try {
      body = ((await req.json()) ?? {}) as Record<string, unknown>
    } catch (_) {
      body = {}
    }

    const requestedCollections = Array.isArray(body.collections)
      ? (body.collections as unknown[])
          .map((value) => (typeof value === 'string' ? value : null))
          .filter((value): value is string => Boolean(value))
      : undefined

    let storedCollections: string[] = []
    try {
      const globalDoc = await payload.findGlobal({ slug: options.bulkGlobalSlug })
      const value = (globalDoc as { collections?: unknown }).collections
      if (Array.isArray(value)) {
        storedCollections = value
          .map((entry) => (typeof entry === 'string' ? entry : null))
          .filter((entry): entry is string => Boolean(entry))
      }
    } catch (_error) {
      storedCollections = []
    }

    const configuredSlugs = Object.keys(options.collectionOptions)
    const selectedCollections = (requestedCollections ?? storedCollections).filter((slug) =>
      configuredSlugs.includes(slug),
    )

    if (!selectedCollections.length) {
      return Response.json(
        { type: 'error', message: 'No collections selected for bulk translation.' },
        { status: 400 },
      )
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const sendProgress = (completed: number, total: number) => {
          controller.enqueue(serializeEvent({ type: 'progress', completed, total }))
        }

        let completedDocuments = 0

        try {
          appendLog(controller, 'info', 'Preparing bulk translation run…')

          const collectionTotals = new Map<string, number>()
          let totalDocuments = 0

          for (const slug of selectedCollections) {
            try {
              const { totalDocs } = await payload.count({ collection: slug })
              collectionTotals.set(slug, totalDocs)
              totalDocuments += totalDocs
              const label = options.collectionLabels[slug] || slug
              appendLog(
                controller,
                'info',
                totalDocs
                  ? `Queued ${totalDocs} documents from ${label}.`
                  : `No documents found in ${label}.`,
              )
            } catch (error) {
              const message =
                error instanceof Error
                  ? error.message
                  : `Failed to count documents for ${slug}.`
              appendLog(controller, 'error', message)
              collectionTotals.set(slug, 0)
            }
          }

          sendProgress(0, totalDocuments)

          if (!totalDocuments) {
            appendLog(controller, 'warning', 'No documents available to translate.')
            controller.enqueue(serializeEvent({ type: 'done' }))
            return
          }

          for (const slug of selectedCollections) {
            const totalForCollection = collectionTotals.get(slug) ?? 0
            if (!totalForCollection) {
              continue
            }

            const collection = payload.collections?.[slug]
            if (!collection?.config) {
              appendLog(controller, 'error', `Collection configuration missing for ${slug}.`)
              completedDocuments += totalForCollection
              sendProgress(completedDocuments, totalDocuments)
              continue
            }

            const label = options.collectionLabels[slug] || slug
            appendLog(controller, 'info', `Processing collection ${label}…`)

            const fieldPatterns = collectLocalizedFieldPatterns(collection.config.fields)
            const exclude = new Set(options.collectionOptions[slug]?.excludeFields ?? [])
            const filteredPatterns = fieldPatterns.filter((pattern) => {
              const [root] = pattern.split('.')
              return root ? !exclude.has(root) : true
            })

            if (!filteredPatterns.length) {
              appendLog(
                controller,
                'warning',
                `No localized fields available for ${label}; skipping collection.`,
              )
              completedDocuments += totalForCollection
              sendProgress(completedDocuments, totalDocuments)
              continue
            }

            const pageSize = 50
            let page = 1

            while (true) {
              let result: { docs?: unknown[]; totalPages?: number } | null = null
              try {
                result = (await payload.find({
                  collection: slug,
                  depth: 0,
                  limit: pageSize,
                  locale: defaultLocale,
                  page,
                })) as { docs?: unknown[]; totalPages?: number }
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : `Failed to load documents for ${label}.`
                appendLog(controller, 'error', message)
                break
              }

              const docs = Array.isArray(result?.docs) ? result?.docs : []

              for (const rawDoc of docs) {
                const record = rawDoc as { [key: string]: unknown }
                const rawId = record?.id ?? record?._id
                let docId: null | number | string = null

                if (typeof rawId === 'string' || typeof rawId === 'number') {
                  docId = rawId
                } else if (hasToString(rawId)) {
                  docId = rawId.toString()
                }

                if (docId === null) {
                  appendLog(controller, 'warning', `Skipping document without identifier in ${label}.`)
                  completedDocuments += 1
                  sendProgress(completedDocuments, totalDocuments)
                  continue
                }

                const docLabel = `${label} #${String(docId)}`
                appendLog(controller, 'info', `Preparing ${docLabel}…`)

                const items = buildTranslatableItems(record, filteredPatterns)
                if (!items.length) {
                  appendLog(controller, 'warning', `${docLabel} has no translatable fields; skipping.`)
                  completedDocuments += 1
                  sendProgress(completedDocuments, totalDocuments)
                  continue
                }

                let reviewLocales: TranslateReviewLocale[] = []
                try {
                  reviewLocales = await generateTranslationReview(payload, {
                    id: docId,
                    collection: slug,
                    from: defaultLocale,
                    items,
                    locales: otherLocales,
                  })
                } catch (error) {
                  const message =
                    error instanceof Error
                      ? error.message
                      : `Failed to evaluate translation needs for ${docLabel}.`
                  appendLog(controller, 'error', message)
                  completedDocuments += 1
                  sendProgress(completedDocuments, totalDocuments)
                  continue
                }

                const needsManualReview = reviewLocales.some(
                  (locale) => (locale.mismatches?.length ?? 0) > 0 && locale.existingCount > 0,
                )

                if (needsManualReview) {
                  appendLog(
                    controller,
                    'warning',
                    `${docLabel} requires manual review; skipping automatic translation.`,
                  )
                  completedDocuments += 1
                  sendProgress(completedDocuments, totalDocuments)
                  continue
                }

                const selections = buildLocaleSelections(reviewLocales, items)

                if (!selections.length) {
                  appendLog(controller, 'info', `${docLabel} is already up-to-date.`)
                  completedDocuments += 1
                  sendProgress(completedDocuments, totalDocuments)
                  continue
                }

                const request: TranslateRequestPayload = {
                  id: docId,
                  collection: slug,
                  from: defaultLocale,
                  locales: selections.map((selection) => ({
                    chunks: chunkItems(selection.translateIndexes.map((index) => items[index])),
                    code: selection.code,
                    overrides: selection.overrides.length ? selection.overrides : undefined,
                  })),
                }

                appendLog(controller, 'info', `Translating ${docLabel}…`)

                let translationFailed = false
                let translationCompleted = false

                try {
                  for await (const event of streamTranslations(payload, request)) {
                    if (event.type === 'progress') {
                      appendLog(
                        controller,
                        'info',
                        `${docLabel}: ${event.locale} ${event.completed}/${event.total}`,
                      )
                    } else if (event.type === 'applied') {
                      appendLog(controller, 'success', `${docLabel}: saved ${event.locale}.`)
                    } else if (event.type === 'error') {
                      translationFailed = true
                      appendLog(controller, 'error', `${docLabel}: ${event.message}`)
                      break
                    } else if (event.type === 'done') {
                      translationCompleted = true
                      break
                    }
                  }
                } catch (error) {
                  translationFailed = true
                  const message =
                    error instanceof Error ? error.message : `Translation failed for ${docLabel}.`
                  appendLog(controller, 'error', message)
                }

                if (!translationFailed && translationCompleted) {
                  appendLog(controller, 'success', `${docLabel} translated successfully.`)
                }

                completedDocuments += 1
                sendProgress(completedDocuments, totalDocuments)
              }

              const totalPages = typeof result?.totalPages === 'number' ? result.totalPages : 1
              if (page >= totalPages) {
                break
              }

              page += 1
            }
          }

          appendLog(controller, 'success', 'Bulk translation run completed.')
          controller.enqueue(serializeEvent({ type: 'done' }))
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Bulk translation failed.'
          appendLog(controller, 'error', message)
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
  }
}
