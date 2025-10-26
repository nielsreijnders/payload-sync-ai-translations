import type { SanitizedServerEditorConfig } from '@payloadcms/richtext-lexical/dist/lexical/config/server/sanitize.js'
import type { Payload } from 'payload'

import { convertHTMLToLexical, defaultEditorConfig, sanitizeServerEditorConfig } from '@payloadcms/richtext-lexical'
import { convertLexicalToHTMLAsync } from '@payloadcms/richtext-lexical/dist/features/converters/lexicalToHtml/async/index.js'
import { JSDOM } from 'jsdom'

import { toLexical } from '../utils/lexical.js'
import { isLexicalValue } from '../utils/localizedFields.js'

type LexicalNode = {
  children?: LexicalNode[]
  text?: string
  type?: string
}

type LexicalRoot = {
  children?: LexicalNode[]
  type?: string
}

type LexicalValue = {
  root?: LexicalRoot
}

function cloneLexicalValue<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value)
  }

  return JSON.parse(JSON.stringify(value)) as T
}

function mapLexicalTextNodes(value: LexicalValue, updater: (text: string) => string) {
  const visit = (node: LexicalNode | undefined) => {
    if (!node || typeof node !== 'object') {
      return
    }

    if (node.type === 'text' && typeof node.text === 'string') {
      node.text = updater(node.text)
    }

    if (Array.isArray(node.children)) {
      node.children.forEach((child) => {
        visit(child)
      })
    }
  }

  visit(value?.root)
}

function collectLexicalTextNodes(value: LexicalValue): string[] {
  const texts: string[] = []

  const visit = (node: LexicalNode | undefined) => {
    if (!node || typeof node !== 'object') {
      return
    }

    if (node.type === 'text' && typeof node.text === 'string') {
      texts.push(node.text)
    }

    if (Array.isArray(node.children)) {
      node.children.forEach((child) => {
        visit(child)
      })
    }
  }

  visit(value?.root)
  return texts
}

export type LexicalTranslationPlan = {
  apply(translated: string[]): unknown
  segments: string[]
}

export function createLexicalTranslationPlan(
  value: unknown,
  fallbackText: string,
): LexicalTranslationPlan {
  if (!isLexicalValue(value)) {
    return {
      apply(translated) {
        const next = translated.length ? translated.join(' ').trim() : ''
        if (!next) {
          return toLexical(fallbackText)
        }
        return toLexical(next)
      },
      segments: [fallbackText],
    }
  }

  const lexicalValue = value as LexicalValue
  const segments = collectLexicalTextNodes(lexicalValue)

  if (!segments.length) {
    return {
      apply(translated) {
        const text = translated.length ? translated.join(' ').trim() : ''
        if (!text) {
          return toLexical(fallbackText)
        }
        return toLexical(text)
      },
      segments: [fallbackText],
    }
  }

  return {
    apply(translated) {
      if (translated.length !== segments.length) {
        const fallback = translated.length ? translated.join(' ').trim() : ''
        if (!fallback) {
          return toLexical(fallbackText)
        }
        return toLexical(fallback)
      }

      const cloned = cloneLexicalValue(lexicalValue)
      let index = 0

      mapLexicalTextNodes(cloned, () => {
        const next = translated[index] ?? ''
        index += 1
        return next
      })

      return cloned
    },
    segments,
  }
}

const configCache = new WeakMap<object, Promise<SanitizedServerEditorConfig>>()

async function getSanitizedEditorConfig(payload: Payload) {
  const key = payload.config as object

  if (!configCache.has(key)) {
    configCache.set(key, sanitizeServerEditorConfig(defaultEditorConfig, payload.config, false))
  }

  return configCache.get(key)!
}

export async function lexicalValueToHTML(value: unknown): Promise<null | string> {
  if (!isLexicalValue(value)) {
    return null
  }

  try {
    const html = await convertLexicalToHTMLAsync({ data: value, disableContainer: true })
    return html.trim() ? html : null
  } catch (_error) {
    return null
  }
}

export async function htmlToLexicalValue(payload: Payload, html: string) {
  const trimmed = html.trim()
  if (!trimmed) {
    return toLexical('')
  }

  try {
    const editorConfig = await getSanitizedEditorConfig(payload)
    return convertHTMLToLexical({ editorConfig, html: trimmed, JSDOM })
  } catch (_error) {
    return toLexical(trimmed)
  }
}
