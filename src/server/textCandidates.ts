import type { TranslatableItem } from '../components/auto-translate-button/utils/buildTranslatableItems.js'

import {
  buildTranslatableItems,
  collectIdentifierPaths,
} from '../components/auto-translate-button/utils/buildTranslatableItems.js'
import { isLexicalValue, serializeLexicalValue } from '../utils/lexical.js'
import { extractPlainText, getValueAtPath } from '../utils/localizedFields.js'

/**
 * Shared text-candidate collection for tools that scan document content
 * (grammar check, find & replace). Walks the configured field patterns plus a
 * conservative fallback over the whole document, skipping structural and
 * identifier-like keys.
 */

const IGNORED_TERMINAL_KEYS = new Set([
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

const IGNORED_TRAVERSAL_KEYS = new Set(['__v', '_id', 'createdat', 'deletedat', 'id', 'updatedat'])

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

  return IGNORED_TERMINAL_KEYS.has(last)
}

function shouldSkipTraversalKey(key: string): boolean {
  const normalized = key.trim().toLowerCase()
  return IGNORED_TRAVERSAL_KEYS.has(normalized)
}

export function collectFallbackTextItems(document: unknown): TranslatableItem[] {
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

export function collectIdentifierPathsFromItemPaths(
  data: unknown,
  items: Array<{ path: string }>,
): string[] {
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

export function mergeIdentifierPaths(...entries: string[][]): string[] {
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

export function buildTextCandidates(
  document: unknown,
  fieldPatterns: string[],
): { identifierPaths: string[]; items: TranslatableItem[] } {
  const scopedItems = buildTranslatableItems(document, fieldPatterns)
  const fallbackItems = collectFallbackTextItems(document)

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
