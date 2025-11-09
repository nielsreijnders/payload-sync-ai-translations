import type { PayloadHandler } from 'payload'

import type { BulkLinkSyncRequestPayload, BulkLinkSyncResponse } from './linkSyncTypes.js'

import { synchronizeLinksForDocument } from './linkSyncService.js'
import { getStoredCollection, getTranslationState } from './translationStateStore.js'

function parseDocumentBody(body: unknown): { collection: string; id: number | string } {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Invalid JSON body')
  }

  const candidate = body as Record<string, unknown>
  const collection = candidate.collection
  const id = candidate.id

  if (typeof collection !== 'string' || !collection.trim()) {
    throw new Error('Missing "collection" slug')
  }

  if (typeof id !== 'string' && typeof id !== 'number') {
    throw new Error('Missing document "id"')
  }

  if (typeof id === 'number') {
    return { id, collection: collection.trim() }
  }

  const trimmedId = id.trim()
  if (!trimmedId) {
    throw new Error('Missing document "id"')
  }

  return { id: trimmedId, collection: collection.trim() }
}

function parseBulkBody(body: unknown): BulkLinkSyncRequestPayload {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Invalid JSON body')
  }

  const candidate = body as Record<string, unknown>
  const collections = candidate.collections

  if (!Array.isArray(collections)) {
    throw new Error('Expected "collections" to be an array')
  }

  const sanitized = Array.from(
    new Set(
      collections
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  )

  if (!sanitized.length) {
    throw new Error('No collections selected for bulk link sync')
  }

  return { collections: sanitized }
}

export function createSyncLinksHandler(): PayloadHandler {
  return async (req) => {
    try {
      const payload = req.payload
      if (!payload) {
        throw new Error('Payload instance is not available on the request')
      }

      const { id, collection } = parseDocumentBody(await (req as any).json())
      const state = getTranslationState()
      const stored = getStoredCollection(collection)

      if (!stored) {
        throw new Error(`Collection "${collection}" is not configured for link synchronization`)
      }

      if (!state.defaultLocale) {
        throw new Error('Default locale is not configured')
      }

      const result = await synchronizeLinksForDocument(
        {
          id,
          collection,
          defaultLocale: state.defaultLocale,
          fieldPatterns: stored.fieldPatterns,
          payload,
          serverURL: payload.config?.serverURL,
          targetLocales: state.locales,
        },
        new Map(),
      )

      return Response.json({ type: 'success', result })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Link sync failed'
      return Response.json({ type: 'error', message }, { status: 400 })
    }
  }
}

export function createBulkSyncLinksHandler(): PayloadHandler {
  return async (req) => {
    try {
      const payload = req.payload
      if (!payload) {
        throw new Error('Payload instance is not available on the request')
      }

      const request = parseBulkBody(await (req as any).json())
      const state = getTranslationState()

      if (!state.defaultLocale) {
        throw new Error('Default locale is not configured')
      }

      const reports: BulkLinkSyncResponse['details'] = []
      let documentsProcessed = 0
      let documentsUpdated = 0
      let updatedLocales = 0
      let replacements = 0
      const warnings: string[] = []
      const errors: string[] = []
      const missingCounts = new Map<string, number>()
      const cache = new Map<string, Map<string, string>>()

      for (const slug of request.collections) {
        const stored = getStoredCollection(slug)
        if (!stored) {
          warnings.push(`Collection "${slug}" is not configured; skipping.`)
          continue
        }

        let page = 1
        let hasMore = true
        const limit = 50

        while (hasMore) {
          const result = await payload.find({
            collection: slug,
            depth: 0,
            fallbackLocale: false,
            limit,
            locale: state.defaultLocale,
            page,
          })

          const docs = Array.isArray(result.docs) ? result.docs : []
          hasMore = Boolean(result.hasNextPage)
          page += 1

          for (const doc of docs) {
            const docIdentifiers = doc as { _id?: unknown; id?: unknown }
            const identifier = docIdentifiers.id ?? docIdentifiers._id
            if (typeof identifier !== 'string' && typeof identifier !== 'number') {
              warnings.push(`Skipped document without identifier in ${slug}`)
              continue
            }

            const label = `${identifier}`
            documentsProcessed += 1

            try {
              const report = await synchronizeLinksForDocument(
                {
                  id: identifier,
                  collection: slug,
                  defaultLocale: state.defaultLocale,
                  fieldPatterns: stored.fieldPatterns,
                  payload,
                  serverURL: payload.config?.serverURL,
                  targetLocales: state.locales,
                },
                cache,
              )

              replacements += report.replacements
              updatedLocales += report.updatedLocales.length
              if (report.updatedLocales.length) {
                documentsUpdated += 1
              }

              for (const entry of report.missingAlternateLocales) {
                missingCounts.set(entry, (missingCounts.get(entry) ?? 0) + 1)
              }

              warnings.push(...report.warnings)
              errors.push(...report.errors)

              reports.push({ ...report, label })
            } catch (error) {
              const message =
                error instanceof Error ? error.message : 'Failed to synchronize document'
              errors.push(`${slug}#${label}: ${message}`)
            }
          }
        }
      }

      const summary: BulkLinkSyncResponse['summary'] = {
        documentsProcessed,
        documentsUpdated,
        errors,
        missingAlternates: Array.from(missingCounts.entries()).map(([locale, count]) => ({
          count,
          locale,
        })),
        replacements,
        updatedLocales,
        warnings,
      }

      const response: BulkLinkSyncResponse = { details: reports, summary }
      return Response.json({ type: 'success', data: response })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Bulk link sync failed'
      return Response.json({ type: 'error', message }, { status: 400 })
    }
  }
}
