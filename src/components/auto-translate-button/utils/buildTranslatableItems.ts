import { isLexicalValue, serializeLexicalValue } from '../../../utils/lexical.js'
import {
  expandConcretePathsFromPattern,
  extractPlainText,
  getValueAtPath,
} from '../../../utils/localizedFields.js'

export type TranslatableItem = { lexical: boolean; path: string; text: string }

export function buildTranslatableItems(data: unknown, fieldPatterns: string[]): TranslatableItem[] {
  const items: TranslatableItem[] = []

  for (const pattern of fieldPatterns) {
    const concretePaths = expandConcretePathsFromPattern(data, pattern)

    for (const path of concretePaths) {
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
