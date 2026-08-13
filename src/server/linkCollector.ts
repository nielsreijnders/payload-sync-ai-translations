import { isLexicalValue } from '../utils/lexical.js'
import { expandConcretePathsFromPattern, getValueAtPath } from '../utils/localizedFields.js'
import { setValueAtPath } from './localeStructure.js'

export type LinkOccurrence =
  | {
      mode: 'string-exact' | 'string-partial'
      path: string
      type: 'string'
      value: string
    }
  | {
      path: string
      type: 'lexical'
      value: string
    }

export type LinkReplacementResult<T> = { changed: boolean; data: T }

const URL_PATTERN = /https?:\/\/[^\s"'<>]+|\/(?!\/)[^\s"'<>]+/gi
const TRAILING_PUNCTUATION = /[),.;!?]+$/

function normalizeMatch(input: string): string {
  let value = input.trim()
  value = value.replace(TRAILING_PUNCTUATION, '')
  return value
}

function extractUrls(text: string): string[] {
  const matches = text.match(URL_PATTERN)
  if (!matches) {
    return []
  }

  const unique = new Set<string>()
  for (const raw of matches) {
    const normalized = normalizeMatch(raw)
    if (!normalized) {
      continue
    }

    if (normalized.startsWith('//')) {
      unique.add(`https:${normalized}`)
      continue
    }

    unique.add(normalized)
  }

  return Array.from(unique)
}

function cloneLexical<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value)
    } catch (_error) {
      /* noop */
    }
  }

  return JSON.parse(JSON.stringify(value)) as T
}

function visitLexical(
  node: unknown,
  iterator: (candidate: Record<string, unknown>) => void,
): void {
  if (typeof node !== 'object' || node === null) {
    return
  }

  const record = node as Record<string, unknown>
  if (record.type === 'link' && record.fields && typeof record.fields === 'object') {
    iterator(record.fields as Record<string, unknown>)
  }

  const children = Array.isArray(record.children) ? (record.children as unknown[]) : []
  children.forEach((child) => visitLexical(child, iterator))
}

function collectFromLexical(path: string, value: unknown, collector: LinkOccurrence[]): void {
  if (!isLexicalValue(value)) {
    return
  }

  visitLexical(value.root, (fields) => {
    const url = fields.url
    if (typeof url === 'string' && url.trim()) {
      collector.push({ type: 'lexical', path, value: url.trim() })
    }
  })
}

function collectFromString(path: string, value: string, collector: LinkOccurrence[]): void {
  const urls = extractUrls(value)
  if (!urls.length) {
    return
  }

  const trimmed = value.trim()
  for (const url of urls) {
    const mode = trimmed === url ? 'string-exact' : 'string-partial'
    collector.push({ type: 'string', mode, path, value: url })
  }
}

export function collectLinkOccurrences(
  data: unknown,
  fieldPatterns: string[],
): LinkOccurrence[] {
  const collected: LinkOccurrence[] = []
  const seen = new Set<string>()

  for (const pattern of fieldPatterns) {
    const concretePaths = expandConcretePathsFromPattern(data, pattern)

    for (const path of concretePaths) {
      const value = getValueAtPath(data, path)

      const before = collected.length
      if (typeof value === 'string') {
        collectFromString(path, value, collected)
      } else {
        collectFromLexical(path, value, collected)
      }

      if (before === collected.length) {
        continue
      }

      for (let index = before; index < collected.length; index += 1) {
        const entry = collected[index]
        const key = `${entry.path}::${entry.value}::${entry.type}::${
          entry.type === 'string' ? entry.mode : 'lexical'
        }`
        if (seen.has(key)) {
          collected.splice(index, 1)
          index -= 1
        } else {
          seen.add(key)
        }
      }
    }
  }

  return collected
}

/**
 * Resolve the locale value for an occurrence path. The id-based lookup keeps
 * replacements on the right row when shared arrays are reordered, but rows of
 * LOCALIZED arrays exist per locale with their own ids, so that lookup finds
 * nothing there. Fall back to the plain positional path — callers verify the
 * source URL before replacing, which keeps the positional match safe.
 */
function resolveOccurrenceValue(
  occurrence: LinkOccurrence,
  baseDoc: unknown,
  data: unknown,
): unknown {
  const idMatched = getValueAtPath(data, occurrence.path, { base: baseDoc })
  if (idMatched !== undefined) {
    return idMatched
  }

  return getValueAtPath(data, occurrence.path)
}

function replaceInString(
  occurrence: Extract<LinkOccurrence, { type: 'string' }>,
  baseDoc: unknown,
  data: unknown,
  replacement: string,
): LinkReplacementResult<unknown> {
  const current = resolveOccurrenceValue(occurrence, baseDoc, data)
  if (typeof current !== 'string' || !current.includes(occurrence.value)) {
    return { changed: false, data }
  }

  const next = occurrence.mode === 'string-exact'
    ? replacement
    : current.split(occurrence.value).join(replacement)

  if (next === current) {
    return { changed: false, data }
  }

  const updated = setValueAtPath(baseDoc, data, occurrence.path, next)
  return { changed: true, data: updated }
}

function replaceInLexical(
  occurrence: Extract<LinkOccurrence, { type: 'lexical' }>,
  baseDoc: unknown,
  data: unknown,
  replacement: string,
): LinkReplacementResult<unknown> {
  const current = resolveOccurrenceValue(occurrence, baseDoc, data)
  if (!isLexicalValue(current)) {
    return { changed: false, data }
  }

  let changed = false
  const clone = cloneLexical(current)

  visitLexical(clone.root, (fields) => {
    const url = fields.url
    if (typeof url === 'string' && url === occurrence.value) {
      fields.url = replacement
      changed = true
    }
  })

  if (!changed) {
    return { changed: false, data }
  }

  const updated = setValueAtPath(baseDoc, data, occurrence.path, clone)
  return { changed: true, data: updated }
}

export function applyLinkOccurrence(
  occurrence: LinkOccurrence,
  baseDoc: unknown,
  data: unknown,
  replacement: string,
): LinkReplacementResult<unknown> {
  if (occurrence.type === 'string') {
    return replaceInString(occurrence, baseDoc, data, replacement)
  }

  return replaceInLexical(occurrence, baseDoc, data, replacement)
}
