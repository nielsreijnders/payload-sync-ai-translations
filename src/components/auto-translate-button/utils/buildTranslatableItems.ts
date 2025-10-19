import {
  expandConcretePathsFromPattern,
  extractPlainText,
  getValueAtPath,
  isLexicalValue,
} from '../../../utils/localizedFields.js'

export type TranslatableItem = { lexical: boolean; path: string; text: string }

export function buildTranslatableItems(data: unknown, fieldPatterns: string[]): TranslatableItem[] {
  const items: TranslatableItem[] = []

  for (const pattern of fieldPatterns) {
    const concretePaths = expandConcretePathsFromPattern(data, pattern)

    for (const path of concretePaths) {
      const value = getValueAtPath(data, path)
      const text = extractPlainText(value)

      if (!text) {
        continue
      }

      const lexical = isLexicalValue(value)
      items.push({ lexical, path, text })
    }
  }

  return items
}
