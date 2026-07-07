import type { Payload } from 'payload'

import type {
  BulkGrammarApplyTarget,
  BulkStreamEvent,
  TranslateOverride,
} from './translationTypes.js'

import { collectIdentifierPaths } from '../components/auto-translate-button/utils/buildTranslatableItems.js'
import { collectIdentifierPathsFromItemPaths, mergeIdentifierPaths } from './textCandidates.js'
import { streamTranslations } from './translationStream.js'

/**
 * Shared "apply reviewed overrides" runner used by tools that first scan
 * content and then write user-approved text overrides back (grammar check,
 * find & replace). Overrides are applied in a single locale.
 */

export type ApplyRunnerEntry = {
  fieldPatterns: string[]
  label: string
  slug: string
}

type CollectionApplyTarget = Extract<BulkGrammarApplyTarget, { collection: string }>
type GlobalApplyTarget = Extract<BulkGrammarApplyTarget, { global: string }>

export function isCollectionApplyTarget(
  target: BulkGrammarApplyTarget,
): target is CollectionApplyTarget {
  return 'collection' in target && typeof target.collection === 'string'
}

export function isGlobalApplyTarget(target: BulkGrammarApplyTarget): target is GlobalApplyTarget {
  return 'global' in target && typeof target.global === 'string'
}

function toGlobalLabel(slug: string): string {
  return `global:${slug}`
}

async function applyCollectionOverrides(
  payload: Payload,
  options: {
    collection: string
    id: number | string
    identifierPaths: string[]
    locale: string
    overrides: TranslateOverride[]
  },
): Promise<null | string> {
  let errorMessage: null | string = null

  for await (const event of streamTranslations(payload, {
    id: options.id,
    collection: options.collection,
    from: options.locale,
    locales: [
      {
        chunks: [],
        code: options.locale,
        identifierPaths: options.identifierPaths,
        overrides: options.overrides,
      },
    ],
  })) {
    if (event.type === 'error') {
      errorMessage = event.message
      break
    }
  }

  return errorMessage
}

async function applyGlobalOverrides(
  payload: Payload,
  options: {
    global: string
    identifierPaths: string[]
    locale: string
    overrides: TranslateOverride[]
  },
): Promise<null | string> {
  let errorMessage: null | string = null

  for await (const event of streamTranslations(payload, {
    from: options.locale,
    global: options.global,
    locales: [
      {
        chunks: [],
        code: options.locale,
        identifierPaths: options.identifierPaths,
        overrides: options.overrides,
      },
    ],
  })) {
    if (event.type === 'error') {
      errorMessage = event.message
      break
    }
  }

  return errorMessage
}

export async function* runApplyFromTargets(
  payload: Payload,
  options: {
    applyTargets: BulkGrammarApplyTarget[]
    locale: string
    noOverridesReason: string
    selectedCollectionsBySlug: Map<string, ApplyRunnerEntry>
    selectedGlobalsBySlug: Map<string, ApplyRunnerEntry>
  },
): AsyncGenerator<BulkStreamEvent> {
  const rawTargets = options.applyTargets
  const selectedCollectionTargets = rawTargets.filter(
    (target): target is CollectionApplyTarget =>
      isCollectionApplyTarget(target) && options.selectedCollectionsBySlug.has(target.collection),
  )
  const selectedGlobalTargets = rawTargets.filter(
    (target): target is GlobalApplyTarget =>
      isGlobalApplyTarget(target) && options.selectedGlobalsBySlug.has(target.global),
  )

  if (!selectedCollectionTargets.length && !selectedGlobalTargets.length) {
    yield { type: 'error', message: 'No scan results found to apply.' }
    return
  }

  const groupedCollections = new Map<string, CollectionApplyTarget[]>()
  for (const target of selectedCollectionTargets) {
    if (!groupedCollections.has(target.collection)) {
      groupedCollections.set(target.collection, [])
    }
    groupedCollections.get(target.collection)?.push(target)
  }

  yield {
    type: 'bulk-start',
    totalCollections: groupedCollections.size + selectedGlobalTargets.length,
    totalDocuments: selectedCollectionTargets.length + selectedGlobalTargets.length,
  }

  let overallProcessed = 0
  let overallSkipped = 0
  let overallFailed = 0

  for (const [collectionSlug, collectionTargets] of groupedCollections.entries()) {
    const entry = options.selectedCollectionsBySlug.get(collectionSlug)
    if (!entry) {
      continue
    }

    let collectionProcessed = 0
    let collectionSkipped = 0
    let collectionFailed = 0

    yield {
      type: 'collection-start',
      collection: collectionSlug,
      label: entry.label,
      totalDocuments: collectionTargets.length,
    }

    for (const target of collectionTargets) {
      const docLabel = String(target.id)
      yield { id: docLabel, type: 'document-start', collection: collectionSlug }

      if (!target.overrides.length) {
        collectionSkipped += 1
        overallSkipped += 1
        yield {
          id: docLabel,
          type: 'document-skipped',
          collection: collectionSlug,
          reason: options.noOverridesReason,
        }
        continue
      }

      let identifierPaths: string[] = []

      try {
        const document = await payload.findByID({
          id: target.id,
          collection: collectionSlug,
          depth: 0,
          fallbackLocale: false,
          locale: options.locale,
        })
        identifierPaths = mergeIdentifierPaths(
          collectIdentifierPaths(document, entry.fieldPatterns),
          collectIdentifierPathsFromItemPaths(document, target.overrides),
        )
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to load document for applying fixes.'
        collectionFailed += 1
        overallFailed += 1
        yield { id: docLabel, type: 'document-error', collection: collectionSlug, message }
        continue
      }

      yield {
        id: docLabel,
        type: 'document-progress',
        collection: collectionSlug,
        completed: 0,
        locale: options.locale,
        total: target.overrides.length,
      }

      const message = await applyCollectionOverrides(payload, {
        id: target.id,
        collection: collectionSlug,
        identifierPaths,
        locale: options.locale,
        overrides: target.overrides,
      })

      if (message) {
        collectionFailed += 1
        overallFailed += 1
        yield { id: docLabel, type: 'document-error', collection: collectionSlug, message }
        continue
      }

      yield {
        id: docLabel,
        type: 'document-applied',
        collection: collectionSlug,
        locale: options.locale,
      }
      yield {
        id: docLabel,
        type: 'document-progress',
        collection: collectionSlug,
        completed: target.overrides.length,
        locale: options.locale,
        total: target.overrides.length,
      }

      collectionProcessed += 1
      overallProcessed += 1
      yield { id: docLabel, type: 'document-success', collection: collectionSlug }
    }

    yield {
      type: 'collection-complete',
      collection: collectionSlug,
      failed: collectionFailed,
      processed: collectionProcessed,
      skipped: collectionSkipped,
    }
  }

  for (const target of selectedGlobalTargets) {
    const entry = options.selectedGlobalsBySlug.get(target.global)
    if (!entry) {
      continue
    }

    const eventCollection = toGlobalLabel(target.global)
    let collectionProcessed = 0
    let collectionSkipped = 0
    let collectionFailed = 0

    yield {
      type: 'collection-start',
      collection: eventCollection,
      label: entry.label,
      totalDocuments: 1,
    }

    yield { id: target.global, type: 'document-start', collection: eventCollection }

    if (!target.overrides.length) {
      collectionSkipped += 1
      overallSkipped += 1
      yield {
        id: target.global,
        type: 'document-skipped',
        collection: eventCollection,
        reason: options.noOverridesReason,
      }
    } else {
      let identifierPaths: string[] = []

      try {
        const document = await payload.findGlobal({
          slug: target.global,
          depth: 0,
          fallbackLocale: false,
          locale: options.locale,
        })
        identifierPaths = mergeIdentifierPaths(
          collectIdentifierPaths(document, entry.fieldPatterns),
          collectIdentifierPathsFromItemPaths(document, target.overrides),
        )
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to load global for applying fixes.'
        collectionFailed += 1
        overallFailed += 1
        yield { id: target.global, type: 'document-error', collection: eventCollection, message }
      }

      if (collectionFailed === 0) {
        yield {
          id: target.global,
          type: 'document-progress',
          collection: eventCollection,
          completed: 0,
          locale: options.locale,
          total: target.overrides.length,
        }

        const message = await applyGlobalOverrides(payload, {
          global: target.global,
          identifierPaths,
          locale: options.locale,
          overrides: target.overrides,
        })

        if (message) {
          collectionFailed += 1
          overallFailed += 1
          yield { id: target.global, type: 'document-error', collection: eventCollection, message }
        } else {
          yield {
            id: target.global,
            type: 'document-applied',
            collection: eventCollection,
            locale: options.locale,
          }
          yield {
            id: target.global,
            type: 'document-progress',
            collection: eventCollection,
            completed: target.overrides.length,
            locale: options.locale,
            total: target.overrides.length,
          }
          collectionProcessed += 1
          overallProcessed += 1
          yield { id: target.global, type: 'document-success', collection: eventCollection }
        }
      }
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
