import type { SanitizedServerEditorConfig } from '@payloadcms/richtext-lexical/dist/lexical/config/server/sanitize.js'
import type { Payload } from 'payload'

import { convertHTMLToLexical, defaultEditorConfig, sanitizeServerEditorConfig } from '@payloadcms/richtext-lexical'
import { convertLexicalToHTMLAsync } from '@payloadcms/richtext-lexical/dist/features/converters/lexicalToHtml/async/index.js'
import { JSDOM } from 'jsdom'

import { toLexical } from '../utils/lexical.js'
import { isLexicalValue } from '../utils/localizedFields.js'

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
