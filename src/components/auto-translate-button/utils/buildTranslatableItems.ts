import { isLexicalValue, serializeLexicalValue } from '../../../utils/lexical.js'
import {
  expandConcretePathsFromPattern,
  extractPlainText,
  getValueAtPath,
} from '../../../utils/localizedFields.js'

const IDENTIFIER_KEYS = new Set(['_id', 'id'])

export type BuildTranslatableItemsOptions = {
  skipFields?: string[]
}

function isIdentifierPath(path: string): boolean {
  if (!path) {
    return false
  }

  const segments = path.split('.')
  const last = segments.at(-1)
  return Boolean(last && IDENTIFIER_KEYS.has(last))
}

export type TranslatableItem = { lexical: boolean; path: string; text: string }

function normalizePathSegments(path: string): string[] {
  return path
    .split('.')
    .map((segment) => segment.trim().replace(/\[\]$/, ''))
    .filter((segment) => segment && !/^\d+$/.test(segment))
}

function normalizeSkipFields(skipFields: string[] = []): string[][] {
  return skipFields
    .map((field) => normalizePathSegments(field))
    .filter((segments) => segments.length > 0)
}

function shouldSkipPath(path: string, skipFields: string[][]): boolean {
  if (!skipFields.length) {
    return false
  }

  const pathSegments = normalizePathSegments(path)
  const compactPath = pathSegments.join('.')

  return skipFields.some((skipSegments) => {
    if (skipSegments.length === 1) {
      return pathSegments.includes(skipSegments[0] ?? '')
    }

    const skipPath = skipSegments.join('.')
    return compactPath === skipPath || compactPath.startsWith(`${skipPath}.`)
  })
}

export function buildTranslatableItems(
  data: unknown,
  fieldPatterns: string[],
  options: BuildTranslatableItemsOptions = {},
): TranslatableItem[] {
  const items: TranslatableItem[] = []
  const skipFields = normalizeSkipFields(options.skipFields)

  for (const pattern of fieldPatterns) {
    const concretePaths = expandConcretePathsFromPattern(data, pattern)

    for (const path of concretePaths) {
      if (isIdentifierPath(path)) {
        continue
      }

      if (shouldSkipPath(path, skipFields)) {
        continue
      }

      const value = getValueAtPath(data, path)

      if (isLexicalValue(value)) {
        const serialized = serializeLexicalValue(value)
        if (!serialized) {
          continue
        }

        items.push({ lexical: true, path, text: serialized.text })
        continue
      }

      const text = extractPlainText(value)
      if (!text) {
        continue
      }

      items.push({ lexical: false, path, text })
    }
  }

  return items
}

export function collectSkippedTranslatablePaths(
  data: unknown,
  fieldPatterns: string[],
  skipFields: string[] = [],
): string[] {
  const normalizedSkipFields = normalizeSkipFields(skipFields)
  if (!normalizedSkipFields.length) {
    return []
  }

  const paths = new Set<string>()

  for (const pattern of fieldPatterns) {
    const concretePaths = expandConcretePathsFromPattern(data, pattern)

    for (const path of concretePaths) {
      if (isIdentifierPath(path)) {
        continue
      }

      if (shouldSkipPath(path, normalizedSkipFields)) {
        paths.add(path)
      }
    }
  }

  return Array.from(paths)
}

export function collectIdentifierPaths(data: unknown, fieldPatterns: string[]): string[] {
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

  const isIndexSegment = (segment: string) => /^\d+$/.test(segment)

  for (const pattern of fieldPatterns) {
    const concretePaths = expandConcretePathsFromPattern(data, pattern)

    for (const path of concretePaths) {
      if (isIdentifierPath(path)) {
        addIdentifierPath(path)
        continue
      }

      const segments = path.split('.')
      for (let index = 0; index < segments.length; index += 1) {
        if (!isIndexSegment(segments[index] ?? '')) {
          continue
        }

        const ancestor = segments.slice(0, index + 1).join('.')
        addIdentifierPath(`${ancestor}.id`)
        addIdentifierPath(`${ancestor}._id`)
      }
    }
  }

  return Array.from(paths)
}
