import type { BulkGrammarApplyTarget, BulkStreamEvent, TranslateOverride } from './translationTypes.js'

const encoder = new TextEncoder()

export function serializeBulkEvent(event: BulkStreamEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`)
}

export function sanitizeSlugArray(value: unknown): string[] {
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

/**
 * Parses an optional per-collection document filter
 * (`{ [collectionSlug]: ids[] }`) used by bulk endpoints to operate on a
 * specific set of documents instead of whole collections.
 */
export function parseDocumentsFilter(
  value: unknown,
): Record<string, Array<number | string>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }

  const parsed: Record<string, Array<number | string>> = {}

  for (const [slug, rawIds] of Object.entries(value as Record<string, unknown>)) {
    if (!slug.trim() || !Array.isArray(rawIds)) {
      continue
    }

    const ids = rawIds.filter(
      (id): id is number | string =>
        (typeof id === 'string' && Boolean(id.trim())) ||
        (typeof id === 'number' && Number.isFinite(id)),
    )

    if (ids.length) {
      parsed[slug.trim()] = ids
    }
  }

  return Object.keys(parsed).length ? parsed : undefined
}

export function toIdentifier(value: unknown): null | number | string {
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

type CollectedApplyTarget = {
  collection?: string
  global?: string
  id?: number | string
  overrides: Map<string, TranslateOverride>
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

export function parseApplyTargets(value: unknown): BulkGrammarApplyTarget[] | undefined {
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
