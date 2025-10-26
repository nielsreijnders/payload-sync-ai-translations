import { isLexicalValue } from './lexical.js'

export type AnyField = {
  blocks?: { fields: AnyField[]; slug: string }[]
  fields?: AnyField[]
  localized?: boolean
  name?: string
  tabs?: { fields: AnyField[] }[]
  type?: string
}

export const MAX_CHARS_PER_CHUNK = 3200

export function collectLocalizedFieldPatterns(fields: AnyField[] = [], prefix = ''): string[] {
  const patterns: string[] = []

  for (const field of fields) {
    if (!field) {
      continue
    }

    const name = field.name
    const currentPath = name ? (prefix ? `${prefix}.${name}` : name) : prefix

    if (field.localized && name) {
      patterns.push(currentPath)
    }

    switch (field.type) {
      case 'array': {
        patterns.push(...collectLocalizedFieldPatterns(field.fields, `${currentPath}[]`))
        break
      }
      case 'blocks': {
        for (const block of field.blocks ?? []) {
          patterns.push(
            ...collectLocalizedFieldPatterns(block.fields, `${currentPath}.${block.slug}`),
          )
        }
        break
      }
      case 'group': {
        patterns.push(...collectLocalizedFieldPatterns(field.fields, currentPath))
        break
      }
      case 'tabs': {
        for (const tab of field.tabs ?? []) {
          patterns.push(...collectLocalizedFieldPatterns(tab.fields, currentPath))
        }
        break
      }
      default:
        break
    }
  }

  return patterns
}

export function expandConcretePathsFromPattern(data: unknown, pattern: string): string[] {
  const tokens = pattern.split('.')
  const out: string[] = []

  const walk = (current: unknown, index: number, acc: string[]) => {
    if (index >= tokens.length) {
      out.push(acc.join('.'))
      return
    }

    if (typeof current !== 'object' || current === null) {
      return
    }

    const segment = tokens[index]
    const next = tokens[index + 1]
    const record = current as Record<string, unknown>

    if (segment.endsWith('[]')) {
      const key = segment.slice(0, -2)
      const value = record[key]
      if (Array.isArray(value)) {
        value.forEach((child, childIndex) => {
          walk(child, index + 1, [...acc, key, String(childIndex)])
        })
      }
      return
    }

    const maybeArray = record[segment]
    const looksLikeBlocks =
      Array.isArray(maybeArray) &&
      maybeArray.some((item) => Boolean((item as { blockType?: unknown })?.blockType))
    if (looksLikeBlocks && typeof next === 'string' && Array.isArray(maybeArray)) {
      maybeArray.forEach((child, childIndex) => {
        const block = child as { blockType?: unknown }
        if (block.blockType === next) {
          walk(child, index + 2, [...acc, segment, String(childIndex)])
        }
      })
      return
    }

    if (segment in record) {
      walk(record[segment], index + 1, [...acc, segment])
    }
  }

  walk(data, 0, [])
  return out
}

export function getValueAtPath(data: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, part) => {
    if (acc === undefined || acc === null) {
      return undefined
    }
    const key = /^\d+$/.test(part) ? Number(part) : part
    if (typeof key === 'number') {
      if (!Array.isArray(acc) || acc.length <= key) {
        return undefined
      }
      return acc[key]
    }
    if (typeof acc === 'object') {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, data)
}

export function extractPlainText(value: unknown): null | string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length ? trimmed : null
  }

  if (isLexicalValue(value)) {
    const root = value.root
    const collected: string[] = []

    const visit = (node: unknown) => {
      if (typeof node !== 'object' || node === null) {
        return
      }

      const record = node as { children?: unknown[]; text?: unknown; type?: unknown }
      if (record.type === 'text' && typeof record.text === 'string') {
        const trimmed = record.text.trim()
        if (trimmed) {
          collected.push(trimmed)
        }
      }
      if (Array.isArray(record.children)) {
        record.children.forEach(visit)
      }
    }

    visit(root)
    const merged = collected.join(' ').replace(/\s+/g, ' ').trim()
    return merged.length ? merged : null
  }

  return null
}

export function chunkItems<T extends { text: string }>(items: T[]): T[][] {
  const chunks: T[][] = []
  let current: T[] = []
  let total = 0

  for (const item of items) {
    const length = item.text.length
    if (current.length && total + length > MAX_CHARS_PER_CHUNK) {
      chunks.push(current)
      current = [item]
      total = length
    } else {
      current.push(item)
      total += length
    }
  }

  if (current.length) {
    chunks.push(current)
  }

  return chunks
}

export function guessDefaultLocale(docConfig: unknown): null | string {
  if (typeof docConfig !== 'object' || docConfig === null) {
    return null
  }

  const localization = (docConfig as { localization?: unknown }).localization
  if (typeof localization !== 'object' || localization === null) {
    return null
  }

  const record = localization as {
    defaultLocale?: unknown
    locales?: unknown
  }

  if (typeof record.defaultLocale === 'string') {
    return record.defaultLocale
  }

  if (Array.isArray(record.locales)) {
    const flagged = record.locales.find(
      (locale) =>
        typeof locale === 'object' && locale !== null && (locale as { default?: unknown }).default,
    )
    if (flagged && typeof (flagged as { code?: unknown }).code === 'string') {
      return (flagged as { code: string }).code
    }

    const first = record.locales[0]
    if (typeof first === 'string') {
      return first
    }
    if (
      typeof first === 'object' &&
      first !== null &&
      typeof (first as { code?: unknown }).code === 'string'
    ) {
      return (first as { code: string }).code
    }
  }

  return null
}

export function getLocaleCodes(docConfig: unknown): string[] {
  if (typeof docConfig !== 'object' || docConfig === null) {
    return []
  }

  const localization = (docConfig as { localization?: unknown }).localization
  if (typeof localization !== 'object' || localization === null) {
    return []
  }

  const record = localization as { locales?: unknown }
  if (!Array.isArray(record.locales)) {
    return []
  }

  const codes: string[] = []
  for (const locale of record.locales) {
    if (typeof locale === 'string') {
      codes.push(locale)
    } else if (typeof locale === 'object' && locale !== null) {
      const code = (locale as { code?: unknown }).code
      if (typeof code === 'string') {
        codes.push(code)
      }
    }
  }

  return codes
}
