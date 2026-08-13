import type { Payload, PayloadHandler } from 'payload'

import type { BulkLinkSyncRequestPayload, BulkLinkSyncResponse } from './linkSyncTypes.js'

import { parseDocumentsFilter, sanitizeSlugArray } from './bulkRequestParsing.js'
import { synchronizeLinksForDocument } from './linkSyncService.js'
import { rejectUnauthenticated } from './requireUser.js'
import {
  getStoredCollection,
  getStoredGlobal,
  getStoredTarget,
  getTranslationState,
} from './translationStateStore.js'

function resolveBaseUrl(
  payload: Payload,
  req: Request,
  configuredBaseUrl?: string,
): string | undefined {
  const configured = configuredBaseUrl?.trim() || payload.config?.serverURL
  if (configured) {
    return configured
  }

  try {
    const parsed = new URL(req.url)
    if (parsed.origin && parsed.origin !== 'null') {
      return parsed.origin
    }
  } catch (_error) {
    // Ignore errors and attempt to infer from headers instead
  }

  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
  if (!host) {
    return undefined
  }

  const protocol = req.headers.get('x-forwarded-proto') ?? 'https'
  return `${protocol}://${host}`
}

function parseDocumentBody(body: unknown): {
  collection?: string
  global?: string
  id?: number | string
} {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Invalid JSON body')
  }

  const candidate = body as Record<string, unknown>
  const collection = candidate.collection
  const global = candidate.global
  const id = candidate.id

  const hasCollection = typeof collection === 'string' && collection.trim().length > 0
  const hasGlobal = typeof global === 'string' && global.trim().length > 0

  if (!hasCollection && !hasGlobal) {
    throw new Error('Missing "collection" or "global" slug')
  }

  if (hasCollection && hasGlobal) {
    throw new Error('Provide either a collection slug or a global slug, not both')
  }

  if (hasGlobal) {
    return { global: global.trim() }
  }

  if (typeof id !== 'string' && typeof id !== 'number') {
    throw new Error('Missing document "id"')
  }

  if (typeof id === 'number') {
    // @ts-expect-error -- Need to investigate
    return { id, collection: collection.trim() }
  }

  const trimmedId = id.trim()
  if (!trimmedId) {
    throw new Error('Missing document "id"')
  }

  // @ts-expect-error -- Need to investigate
  return { id: trimmedId, collection: collection.trim() }
}

function parseBulkBody(body: unknown): BulkLinkSyncRequestPayload {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Invalid JSON body')
  }

  const candidate = body as Record<string, unknown>

  if (candidate.collections !== undefined && !Array.isArray(candidate.collections)) {
    throw new Error('Expected "collections" to be an array')
  }

  if (candidate.globals !== undefined && !Array.isArray(candidate.globals)) {
    throw new Error('Expected "globals" to be an array')
  }

  const collections = sanitizeSlugArray(candidate.collections)
  const globals = sanitizeSlugArray(candidate.globals)

  if (!collections.length && !globals.length) {
    throw new Error('No collections or globals selected for bulk link sync')
  }

  return { collections, documents: parseDocumentsFilter(candidate.documents), globals }
}

export function createSyncLinksHandler(configuredBaseUrl?: string): PayloadHandler {
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

      const target = parseDocumentBody(await (req as any).json())
      const state = getTranslationState()
      const stored = getStoredTarget(target)

      if (!stored) {
        throw new Error('The requested document is not configured for link synchronization')
      }

      if (!state.defaultLocale) {
        throw new Error('Default locale is not configured')
      }

      // @ts-expect-error -- Need to investigate
      const serverURL = resolveBaseUrl(payload, req, configuredBaseUrl)

      const result = await synchronizeLinksForDocument(
        // @ts-expect-error -- Need to investigate
        {
          ...target,
          defaultLocale: state.defaultLocale,
          fieldPatterns: stored.fieldPatterns,
          payload,
          serverURL,
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

export function createBulkSyncLinksHandler(configuredBaseUrl?: string): PayloadHandler {
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

      const request = parseBulkBody(await (req as any).json())
      const state = getTranslationState()

      // @ts-expect-error -- Need to investigate
      const serverURL = resolveBaseUrl(payload, req, configuredBaseUrl)

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
      const checkedCandidates = new Map<string, boolean>()

      for (const slug of request.collections) {
        const stored = getStoredCollection(slug)
        if (!stored) {
          warnings.push(`Collection "${slug}" is not configured; skipping.`)
          continue
        }

        let page = 1
        let hasMore = true
        const limit = 50
        const documentIds = request.documents?.[slug]

        while (hasMore) {
          const result = await payload.find({
            collection: slug,
            depth: 0,
            fallbackLocale: false,
            limit,
            locale: state.defaultLocale,
            page,
            ...(documentIds ? { where: { id: { in: documentIds } } } : {}),
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
                  serverURL,
                  targetLocales: state.locales,
                },
                cache,
                checkedCandidates,
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

      for (const slug of request.globals ?? []) {
        const stored = getStoredGlobal(slug)
        if (!stored) {
          warnings.push(`Global "${slug}" is not configured; skipping.`)
          continue
        }

        documentsProcessed += 1

        try {
          const report = await synchronizeLinksForDocument(
            {
              defaultLocale: state.defaultLocale,
              fieldPatterns: stored.fieldPatterns,
              global: slug,
              payload,
              serverURL,
              targetLocales: state.locales,
            },
            cache,
            checkedCandidates,
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

          reports.push({ ...report, label: slug })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to synchronize global'
          errors.push(`global:${slug}: ${message}`)
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
