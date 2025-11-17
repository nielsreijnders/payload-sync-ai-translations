import { isLexicalValue, serializeLexicalValue } from '../../../utils/lexical.js'
import {
  expandConcretePathsFromPattern,
  extractPlainText,
  getValueAtPath,
} from '../../../utils/localizedFields.js'

const IDENTIFIER_KEYS = new Set(['id', '_id'])

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

  for (const pattern of fieldPatterns) {
    const concretePaths = expandConcretePathsFromPattern(data, pattern)

    for (const path of concretePaths) {
      if (isIdentifierPath(path)) {
        paths.add(path)
      }
    }
  }

  return Array.from(paths)
}
