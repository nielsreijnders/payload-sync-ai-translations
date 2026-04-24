import type { Payload, PayloadHandler } from 'payload'

import type { TranslatableItem } from '../components/auto-translate-button/utils/buildTranslatableItems.js'
import type {
  BulkGrammarApplyTarget,
  BulkGrammarCheckRequestPayload,
  BulkStreamEvent,
  TranslateOverride,
} from './translationTypes.js'

import {
  buildTranslatableItems,
  collectIdentifierPaths,
} from '../components/auto-translate-button/utils/buildTranslatableItems.js'
import { isLexicalValue, serializeLexicalValue } from '../utils/lexical.js'
import { chunkItems, extractPlainText, getValueAtPath } from '../utils/localizedFields.js'
import { resolveCustomPrompt } from './customPrompt.js'
import { logDebug } from './debugSettings.js'
import { openAiProofreadTexts } from './openAiTranslationClient.js'
import {
  getStoredCollection,
  getStoredGlobal,
  getTranslationState,
} from './translationStateStore.js'
import { streamTranslations } from './translationStream.js'

const encoder = new TextEncoder()

type CollectionApplyTarget = Extract<BulkGrammarApplyTarget, { collection: string }>
type GlobalApplyTarget = Extract<BulkGrammarApplyTarget, { global: string }>
type StoredCollectionEntry = NonNullable<ReturnType<typeof getStoredCollection>>
type StoredGlobalEntry = NonNullable<ReturnType<typeof getStoredGlobal>>
type TypoOverride = {
  before: string
} & TranslatableItem

type CollectedApplyTarget = {
  collection?: string
  global?: string
  id?: number | string
  overrides: Map<string, TranslateOverride>
}

function isCollectionApplyTarget(target: BulkGrammarApplyTarget): target is CollectionApplyTarget {
  return 'collection' in target && typeof target.collection === 'string'
}

function isGlobalApplyTarget(target: BulkGrammarApplyTarget): target is GlobalApplyTarget {
  return 'global' in target && typeof target.global === 'string'
}

function serializeEvent(event: BulkStreamEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`)
}

function sanitizeSlugArray(value: unknown): string[] {
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

function parseApplyOverride(value: unknown): null | TranslateOverride {
  if (typeof value !== 'object' || value === null) {
    return null
  }

  const candidate = value as Record<string, unknown>
  const path = candidate.path
  const text = candidate.text

  if (typeof path !== 'string' || !path.trim()) {
    return null
  }

  if (typeof text !== 'string' || !text.trim()) {
    return null
  }

  return {
    lexical: Boolean(candidate.lexical),
    path: path.trim(),
    text,
  }
}

function parseApplyTargets(value: unknown): BulkGrammarApplyTarget[] | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!Array.isArray(value)) {
    throw new Error('Expected "applyTargets" to be an array')
  }

  const merged = new Map<string, CollectedApplyTarget>()

  for (const rawEntry of value) {
    if (typeof rawEntry !== 'object' || rawEntry === null) {
      throw new Error('Expected each apply target to be an object')
    }

    const entry = rawEntry as Record<string, unknown>
    const global = typeof entry.global === 'string' ? entry.global.trim() : ''
    const collection = typeof entry.collection === 'string' ? entry.collection.trim() : ''
    const id = toIdentifier(entry.id)

    if (!Array.isArray(entry.overrides)) {
      throw new Error('Expected each apply target to include an "overrides" array')
    }

    if (global) {
      const key = `global:${global}`
      if (!merged.has(key)) {
        merged.set(key, {
          global,
          overrides: new Map(),
        })
      }

      const current = merged.get(key)
      if (!current) {
        continue
      }

      for (const rawOverride of entry.overrides) {
        const override = parseApplyOverride(rawOverride)
        if (!override) {
          continue
        }

        current.overrides.set(`${override.path}|${override.lexical ? '1' : '0'}`, override)
      }

      continue
    }

    if (!collection) {
      throw new Error('Expected each collection apply target to include a "collection"')
    }

    if (id === null) {
      throw new Error('Expected each collection apply target to include a valid "id"')
    }

    const key = `${collection}#${String(id)}`
    if (!merged.has(key)) {
      merged.set(key, {
        id,
        collection,
        overrides: new Map(),
      })
    }

    const current = merged.get(key)
    if (!current) {
      continue
    }

    for (const rawOverride of entry.overrides) {
      const override = parseApplyOverride(rawOverride)
      if (!override) {
        continue
      }

      current.overrides.set(`${override.path}|${override.lexical ? '1' : '0'}`, override)
    }
  }

  const targets: BulkGrammarApplyTarget[] = []

  for (const entry of merged.values()) {
    if (entry.global) {
      targets.push({
        global: entry.global,
        overrides: Array.from(entry.overrides.values()),
      })
      continue
    }

    if (!entry.collection || entry.id === undefined) {
      continue
    }

    targets.push({
      id: entry.id,
      collection: entry.collection,
      overrides: Array.from(entry.overrides.values()),
    })
  }

  return targets
}

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

const GRAMMAR_SCAN_IGNORED_TERMINAL_KEYS = new Set([
  '__v',
  '_id',
  'blockname',
  'blocktype',
  'createdat',
  'deletedat',
  'id',
  'internal',
  'linktype',
  'relationto',
  'singularslug',
  'slug',
  'target',
  'updatedat',
  'value',
])

const GRAMMAR_SCAN_IGNORED_TRAVERSAL_KEYS = new Set([
  '__v',
  '_id',
  'createdat',
  'deletedat',
  'id',
  'updatedat',
])

function isIndexSegment(segment: string): boolean {
  return /^\d+$/.test(segment)
}

function shouldSkipTerminalPath(path: string): boolean {
  const segments = path
    .split('.')
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean)

  const last = segments.at(-1)
  if (!last) {
    return true
  }

  return GRAMMAR_SCAN_IGNORED_TERMINAL_KEYS.has(last)
}

function shouldSkipTraversalKey(key: string): boolean {
  const normalized = key.trim().toLowerCase()
  return GRAMMAR_SCAN_IGNORED_TRAVERSAL_KEYS.has(normalized)
}

function collectFallbackGrammarItems(document: unknown): TranslatableItem[] {
  const items: TranslatableItem[] = []

  const walk = (value: unknown, segments: string[]) => {
    const path = segments.join('.')

    if (isLexicalValue(value)) {
      if (!path || shouldSkipTerminalPath(path)) {
        return
      }

      const serialized = serializeLexicalValue(value)
      const text = serialized?.text?.trim()
      if (!text) {
        return
      }

      items.push({ lexical: true, path, text })
      return
    }

    if (typeof value === 'string') {
      if (!path || shouldSkipTerminalPath(path)) {
        return
      }

      const text = extractPlainText(value)
      if (!text) {
        return
      }

      items.push({ lexical: false, path, text })
      return
    }

    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, [...segments, String(index)]))
      return
    }

    if (typeof value !== 'object' || value === null) {
      return
    }

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (!key || shouldSkipTraversalKey(key)) {
        continue
      }

      walk(child, [...segments, key])
    }
  }

  walk(document, [])
  return items
}

function collectIdentifierPathsFromItemPaths(data: unknown, items: TranslatableItem[]): string[] {
  const paths = new Set<string>()

  const addIdentifierPath = (path: string) => {
    if (!path) {
      return
    }

    const value = getValueAtPath(data, path)
    if (value === undefined) {
      return
    }

    paths.add(path)
  }

  for (const item of items) {
    const segments = item.path.split('.')

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] ?? ''
      if (!isIndexSegment(segment)) {
        continue
      }

      const ancestor = segments.slice(0, index + 1).join('.')
      addIdentifierPath(`${ancestor}.id`)
      addIdentifierPath(`${ancestor}._id`)
    }
  }

  return Array.from(paths)
}

function mergeIdentifierPaths(...entries: string[][]): string[] {
  const merged = new Set<string>()

  for (const list of entries) {
    for (const entry of list) {
      const normalized = entry.trim()
      if (normalized) {
        merged.add(normalized)
      }
    }
  }

  return Array.from(merged)
}

function buildGrammarCandidates(
  document: unknown,
  fieldPatterns: string[],
): { identifierPaths: string[]; items: TranslatableItem[] } {
  const scopedItems = buildTranslatableItems(document, fieldPatterns)
  const fallbackItems = collectFallbackGrammarItems(document)

  const merged = new Map<string, TranslatableItem>()

  for (const item of [...scopedItems, ...fallbackItems]) {
    const key = `${item.lexical ? '1' : '0'}:${item.path}`
    if (!merged.has(key)) {
      merged.set(key, item)
    }
  }

  const items = Array.from(merged.values())

  const identifierPaths = mergeIdentifierPaths(
    collectIdentifierPaths(document, fieldPatterns),
    collectIdentifierPathsFromItemPaths(document, items),
  )

  return {
    identifierPaths,
    items,
  }
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

async function applyCollectionOverrides(
  payload: Payload,
  options: {
    collection: string
    defaultLocale: string
    id: number | string
    identifierPaths: string[]
    overrides: TranslateOverride[]
  },
): Promise<null | string> {
  let errorMessage: null | string = null

  for await (const event of streamTranslations(payload, {
    id: options.id,
    collection: options.collection,
    from: options.defaultLocale,
    locales: [
      {
        chunks: [],
        code: options.defaultLocale,
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
    defaultLocale: string
    global: string
    identifierPaths: string[]
    overrides: TranslateOverride[]
  },
): Promise<null | string> {
  let errorMessage: null | string = null

  for await (const event of streamTranslations(payload, {
    from: options.defaultLocale,
    global: options.global,
    locales: [
      {
        chunks: [],
        code: options.defaultLocale,
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

function asApplyOverrides(overrides: TypoOverride[]): TranslateOverride[] {
  return overrides.map((override) => ({
    lexical: override.lexical,
    path: override.path,
    text: override.text,
  }))
}

async function* runApplyFromTargets(
  payload: Payload,
  options: {
    defaultLocale: string
    request: BulkGrammarCheckRequestPayload
    selectedCollectionsBySlug: Map<string, StoredCollectionEntry>
    selectedGlobalsBySlug: Map<string, StoredGlobalEntry>
  },
): AsyncGenerator<BulkStreamEvent> {
  const rawTargets = options.request.applyTargets ?? []
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
      collection: toCollectionLabel(collectionSlug),
      label: entry.label,
      totalDocuments: collectionTargets.length,
    }

    for (const target of collectionTargets) {
      const docLabel = String(target.id)
      const eventCollection = toCollectionLabel(collectionSlug)
      yield { id: docLabel, type: 'document-start', collection: eventCollection }

      if (!target.overrides.length) {
        collectionSkipped += 1
        overallSkipped += 1
        yield {
          id: docLabel,
          type: 'document-skipped',
          collection: eventCollection,
          reason: 'No typo corrections available for this document.',
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
          locale: options.defaultLocale,
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
        yield { id: docLabel, type: 'document-error', collection: eventCollection, message }
        continue
      }

      yield {
        id: docLabel,
        type: 'document-progress',
        collection: eventCollection,
        completed: 0,
        locale: options.defaultLocale,
        total: target.overrides.length,
      }

      const message = await applyCollectionOverrides(payload, {
        id: target.id,
        collection: collectionSlug,
        defaultLocale: options.defaultLocale,
        identifierPaths,
        overrides: target.overrides,
      })

      if (message) {
        collectionFailed += 1
        overallFailed += 1
        yield { id: docLabel, type: 'document-error', collection: eventCollection, message }
        continue
      }

      yield {
        id: docLabel,
        type: 'document-applied',
        collection: eventCollection,
        locale: options.defaultLocale,
      }
      yield {
        id: docLabel,
        type: 'document-progress',
        collection: eventCollection,
        completed: target.overrides.length,
        locale: options.defaultLocale,
        total: target.overrides.length,
      }

      collectionProcessed += 1
      overallProcessed += 1
      yield { id: docLabel, type: 'document-success', collection: eventCollection }
    }

    yield {
      type: 'collection-complete',
      collection: toCollectionLabel(collectionSlug),
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
        reason: 'No typo corrections available for this global.',
      }
    } else {
      let identifierPaths: string[] = []

      try {
        const document = await payload.findGlobal({
          slug: target.global,
          depth: 0,
          fallbackLocale: false,
          locale: options.defaultLocale,
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
          locale: options.defaultLocale,
          total: target.overrides.length,
        }

        const message = await applyGlobalOverrides(payload, {
          defaultLocale: options.defaultLocale,
          global: target.global,
          identifierPaths,
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
            locale: options.defaultLocale,
          }
          yield {
            id: target.global,
            type: 'document-progress',
            collection: eventCollection,
            completed: target.overrides.length,
            locale: options.defaultLocale,
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
      defaultLocale,
      request,
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

        const { identifierPaths, items } = buildGrammarCandidates(doc, entry.fieldPatterns)

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

    const { identifierPaths, items } = buildGrammarCandidates(globalDoc, entry.fieldPatterns)

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
              controller.enqueue(serializeEvent(event))
              if (event.type === 'error') {
                break
              }
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : 'Failed to run bulk grammar check.'
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
