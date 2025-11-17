import { isLexicalValue, serializeLexicalValue } from '../../../utils/lexical.js'
import {
  expandConcretePathsFromPattern,
  extractPlainText,
  getValueAtPath,
} from '../../../utils/localizedFields.js'

const IDENTIFIER_KEYS = new Set(['_id', 'id'])

function isIdentifierPath(path: string): boolean {
  if (!path) {
    return false
  }

  const segments = path.split('.')
  const last = segments.at(-1)
  return Boolean(last && IDENTIFIER_KEYS.has(last))
}

export type TranslatableItem = { lexical: boolean; path: string; text: string }

export function buildTranslatableItems(data: unknown, fieldPatterns: string[]): TranslatableItem[] {
  const items: TranslatableItem[] = []

  for (const pattern of fieldPatterns) {
    const concretePaths = expandConcretePathsFromPattern(data, pattern)

    for (const path of concretePaths) {
      if (isIdentifierPath(path)) {
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
