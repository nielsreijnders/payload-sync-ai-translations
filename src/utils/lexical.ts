const START_TOKEN_PREFIX = '[[LEX-'
const END_TOKEN_PREFIX = '[[/LEX-'
const TOKEN_SUFFIX = ']]'
const PLACEHOLDER_PATTERN = /\[\[LEX-(\d+)\]\]([\s\S]*?)\[\[\/LEX-\1\]\]/g

type LexicalNode = {
  children?: LexicalNode[]
  text?: string
  type?: string
}

type LexicalRoot = {
  children?: LexicalNode[]
  type: 'root'
}

type LexicalValue = { root: LexicalRoot }

type SerializedLexical = {
  paths: number[][]
  text: string
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value)
    } catch (_error) {
      // ignore and fall back to JSON clone
    }
  }

  return JSON.parse(JSON.stringify(value)) as T
}

function createTextNode(text: string): LexicalNode {
  return {
    type: 'text',
    detail: 0,
    format: 0,
    mode: 'normal',
    style: '',
    text,
    version: 1,
  } as unknown as LexicalNode
}

function createParagraph(children: LexicalNode[]): LexicalNode {
  return {
    type: 'paragraph',
    children,
    direction: 'ltr',
    format: '',
    indent: 0,
    textFormat: 0,
    textStyle: '',
    version: 1,
  } as unknown as LexicalNode
}

function createStartToken(index: number): string {
  return `${START_TOKEN_PREFIX}${index}${TOKEN_SUFFIX}`
}

function createEndToken(index: number): string {
  return `${END_TOKEN_PREFIX}${index}${TOKEN_SUFFIX}`
}

function getChildren(node: unknown): LexicalNode[] {
  if (typeof node !== 'object' || node === null) {
    return []
  }

  const children = (node as { children?: unknown }).children
  if (!Array.isArray(children)) {
    return []
  }

  return children as LexicalNode[]
}

function isTextNode(node: unknown): node is { text: string } & LexicalNode {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node as { type?: unknown }).type === 'text' &&
    typeof (node as { text?: unknown }).text === 'string'
  )
}

function isLineBreak(node: unknown): boolean {
  return (
    typeof node === 'object' && node !== null && (node as { type?: unknown }).type === 'linebreak'
  )
}

function isListItem(node: unknown): boolean {
  return (
    typeof node === 'object' && node !== null && (node as { type?: unknown }).type === 'listitem'
  )
}

function collectSerialized(
  node: LexicalNode,
  depth: number,
  path: number[],
  parts: string[],
  paths: number[][],
): void {
  if (isTextNode(node)) {
    if (!node.text) {
      return
    }

    const index = paths.length
    paths.push(path)
    parts.push(`${createStartToken(index)}${node.text}${createEndToken(index)}`)
    return
  }

  if (isLineBreak(node)) {
    parts.push('\n')
    return
  }

  const children = getChildren(node)
  if (!children.length) {
    return
  }

  const isTopLevelBlock = depth === 1
  const isListItemNode = isListItem(node)
  const before = parts.length

  children.forEach((child, childIndex) => {
    collectSerialized(child, depth + 1, [...path, childIndex], parts, paths)
  })

  if (isListItemNode) {
    parts.push('\n')
  } else if (isTopLevelBlock && parts.length > before) {
    parts.push('\n\n')
  }
}

function parsePlaceholders(input: string, expected?: number): null | string[] {
  const matches = [...input.matchAll(PLACEHOLDER_PATTERN)]
  if (!matches.length) {
    return null
  }

  const values = new Map<number, string>()
  for (const match of matches) {
    const index = Number(match[1])
    if (Number.isInteger(index)) {
      values.set(index, match[2])
    }
  }

  if (expected !== undefined && values.size !== expected) {
    return null
  }

  const ordered = Array.from(values.entries()).sort((a, b) => a[0] - b[0])

  if (expected !== undefined) {
    if (ordered.length !== expected) {
      return null
    }
    for (let i = 0; i < expected; i += 1) {
      if (!values.has(i)) {
        return null
      }
    }
  }

  return ordered.map((entry) => entry[1])
}

function setTextAtPath(root: LexicalRoot, path: number[], text: string) {
  let current: LexicalNode = root

  for (let i = 0; i < path.length; i += 1) {
    const index = path[i]
    const children = getChildren(current)
    if (!children.length || index < 0 || index >= children.length) {
      return
    }

    const next = children[index]
    if (i === path.length - 1) {
      if (isTextNode(next)) {
        next.text = text
      }
      return
    }

    current = next
  }
}

function createFallbackLexical(text: string): LexicalValue {
  const trimmed = text.trim()
  const segments = trimmed ? trimmed.split(/\n{2,}/).map((segment) => segment.trim()) : ['']

  const children = segments.map((segment) => {
    const paragraphChildren = segment ? [createTextNode(segment)] : []
    return createParagraph(paragraphChildren)
  })

  if (!children.length) {
    children.push(createParagraph([]))
  }

  return {
    root: {
      type: 'root',
      children,
      // @ts-expect-error have to look into this
      direction: 'ltr',
      format: '',
      indent: 0,
      version: 1,
    },
  }
}

export function isLexicalValue(value: unknown): value is LexicalValue {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const root = (value as { root?: unknown }).root
  if (typeof root !== 'object' || root === null) {
    return false
  }

  return (root as { type?: unknown }).type === 'root'
}

export function serializeLexicalValue(value: unknown): null | SerializedLexical {
  if (!isLexicalValue(value)) {
    return null
  }

  const root = value.root
  const children = getChildren(root)
  if (!children.length) {
    return null
  }

  const parts: string[] = []
  const paths: number[][] = []

  children.forEach((child, index) => {
    collectSerialized(child, 1, [index], parts, paths)
  })

  if (!paths.length) {
    return null
  }

  let text = parts.join('')
  text = text.replace(/\n{3,}/g, '\n\n')
  text = text.replace(/\n+$/, '')

  return { paths, text }
}

export function stripLexicalMarkers(text: string): string {
  if (!text) {
    return text
  }

  return text.replace(PLACEHOLDER_PATTERN, '$2')
}

export function toLexical(text: string, template?: unknown) {
  if (template && isLexicalValue(template)) {
    const serialized = serializeLexicalValue(template)
    if (serialized) {
      const replacements = parsePlaceholders(text, serialized.paths.length)
      if (replacements) {
        const clone = cloneValue(template)
        serialized.paths.forEach((path, index) => {
          setTextAtPath(clone.root, path, replacements[index] ?? '')
        })
        return clone
      }
    }
  }

  const replacements = parsePlaceholders(text)
  const plain = replacements ? replacements.join('') : text
  return createFallbackLexical(plain)
}
