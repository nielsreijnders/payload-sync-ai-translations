import { isPlainObject, type Payload } from 'payload'

import type {
  TranslateChunk,
  TranslateLocaleRequestPayload,
  TranslateRequestPayload,
  TranslateStreamEvent,
} from './translationTypes.js'

import { splitLexicalText, toLexical } from '../utils/lexical.js'
import { getValueAtPath, MAX_CHARS_PER_CHUNK } from '../utils/localizedFields.js'
import { stripDocumentMetadata } from './documentUtils.js'
import { cloneLocaleData, mergeStructuralData, setValueAtPath } from './localeStructure.js'
import { openAiTranslateTexts } from './openAiTranslationClient.js'

function countItems(chunks: TranslateChunk[]): number {
  return chunks.reduce((total, chunk) => total + chunk.length, 0)
}

function countOverrides(entries: TranslateLocaleRequestPayload['overrides']): number {
  return Array.isArray(entries) ? entries.length : 0
}

function countLocalesItems(locales: TranslateLocaleRequestPayload[]): number {
  return locales.reduce(
    (total, locale) => total + countItems(locale.chunks) + countOverrides(locale.overrides),
    0,
  )
}

type ExpandedChunkEntry = {
  item: TranslateChunk[number]
  itemIndex: number
  partIndex: number
  parts: number
  text: string
}

function expandChunk(chunk: TranslateChunk): ExpandedChunkEntry[] {
  const expanded: ExpandedChunkEntry[] = []

  chunk.forEach((item, index) => {
    if (item.lexical && item.text.length > MAX_CHARS_PER_CHUNK) {
      const segments = splitLexicalText(item.text, MAX_CHARS_PER_CHUNK)
      if (segments.length) {
        segments.forEach((segment, segmentIndex) => {
          expanded.push({
            item,
            itemIndex: index,
            partIndex: segmentIndex,
            parts: segments.length,
            text: segment,
          })
        })
        return
      }
    }

    expanded.push({ item, itemIndex: index, partIndex: 0, parts: 1, text: item.text })
  })

  return expanded
}

export async function* streamTranslations(
  payload: Payload,
  input: TranslateRequestPayload,
): AsyncGenerator<TranslateStreamEvent> {
  const { id, collection, from, locales } = input

  if (!Array.isArray(locales) || !locales.length) {
    yield { type: 'error', message: 'No target locales provided.' }
    return
  }

  const totalItems = countLocalesItems(locales)
  if (!totalItems) {
    yield { type: 'error', message: 'No translation items provided.' }
    return
  }

  const localeList = locales.map((locale) => locale.code).join(', ')
  payload.logger?.info?.(
    `[AI Translate] Starting translation for ${collection}#${id} from ${from} to [${localeList}].`,
  )

  // Fetch base document once (default locale) to preserve structural data such as blockType
  let baseDoc: null | Record<string, unknown> = null
  try {
    const doc = await payload.findByID({
      id,
      collection,
      depth: 0,
      fallbackLocale: false,
      locale: from,
    })
    if (doc && typeof doc === 'object') {
      baseDoc = doc as Record<string, unknown>
      stripDocumentMetadata(baseDoc)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load base document.'
    yield { type: 'error', message }
    return
  }

  for (const localeEntry of locales) {
    const { chunks, code: locale } = localeEntry
    let existingLocaleDoc: null | Record<string, unknown> = null

    try {
      const localeDoc = await payload.findByID({ id, collection, depth: 0, locale })
      if (localeDoc && typeof localeDoc === 'object') {
        existingLocaleDoc = localeDoc as Record<string, unknown>
        stripDocumentMetadata(existingLocaleDoc)
      }
    } catch (_error) {
      existingLocaleDoc = null
    }
    const overrideItems = Array.isArray(localeEntry.overrides) ? localeEntry.overrides : []
    const localeTotalItems = countItems(chunks) + overrideItems.length

    if (!localeTotalItems) {
      continue
    }

    let localeData: unknown = existingLocaleDoc ? cloneLocaleData(existingLocaleDoc) : {}

    if (!isPlainObject(localeData)) {
      localeData = {}
    }

    stripDocumentMetadata(localeData)

    if (baseDoc) {
      localeData = mergeStructuralData(baseDoc, localeData)
      stripDocumentMetadata(localeData)
    }

    let completed = 0

    for (const chunk of chunks) {
      const expanded = expandChunk(chunk)
      const texts = expanded.map((entry) => entry.text)

      let translated: string[]
      try {
        translated = await openAiTranslateTexts(texts, from, locale)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to translate chunk'
        payload.logger?.error?.(
          `[AI Translate] OpenAI translation failed for ${collection}#${id} (${locale}): ${message}`,
        )
        yield { type: 'error', message }
        return
      }

      if (translated.length !== expanded.length) {
        yield {
          type: 'error',
          message: `Translator mismatch: expected ${expanded.length}, received ${translated.length}`,
        }
        payload.logger?.error?.(
          `[AI Translate] Translation mismatch for ${collection}#${id} (${locale}).`,
        )
        return
      }

      const combined = new Map<number, string>()
      const buffers = new Map<number, { parts: string[]; total: number }>()

      expanded.forEach((entry, entryIndex) => {
        const translatedText = translated[entryIndex] ?? ''

        if (entry.parts === 1) {
          combined.set(entry.itemIndex, translatedText)
          return
        }

        let buffer = buffers.get(entry.itemIndex)
        if (!buffer) {
          buffer = { parts: new Array(entry.parts).fill(''), total: entry.parts }
          buffers.set(entry.itemIndex, buffer)
        }

        buffer.parts[entry.partIndex] = translatedText

        if (buffer.parts.every((part) => part.length > 0)) {
          combined.set(entry.itemIndex, buffer.parts.join(''))
        }
      })

      for (let index = 0; index < chunk.length; index += 1) {
        if (!combined.has(index)) {
          yield {
            type: 'error',
            message: 'Translator response was incomplete for a lexical field.',
          }
          payload.logger?.error?.(
            `[AI Translate] Incomplete translation received for ${collection}#${id} (${locale}).`,
          )
          return
        }

        const item = chunk[index]
        const translatedText = combined.get(index) ?? ''
        const templateValue = baseDoc ? getValueAtPath(baseDoc, item.path) : undefined
        const nextValue = item.lexical ? toLexical(translatedText, templateValue) : translatedText
        localeData = setValueAtPath(baseDoc, localeData, item.path, nextValue)
        completed += 1
        yield { type: 'progress', completed, locale, total: localeTotalItems }
      }
    }

    if (overrideItems.length) {
      for (const override of overrideItems) {
        const templateValue = baseDoc ? getValueAtPath(baseDoc, override.path) : undefined
        const nextValue = override.lexical ? toLexical(override.text, templateValue) : override.text
        localeData = setValueAtPath(baseDoc, localeData, override.path, nextValue)
        completed += 1
        yield { type: 'progress', completed, locale, total: localeTotalItems }
      }
    }

    if (typeof localeData !== 'object' || localeData === null || Array.isArray(localeData)) {
      yield { type: 'error', message: 'Translated data has unexpected shape.' }
      return
    }

    try {
      stripDocumentMetadata(localeData)
      await payload.update({
        id,
        collection,
        data: localeData as Record<string, unknown>,
        locale,
        overrideAccess: true,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to update locale ${locale}`
      payload.logger?.error?.(
        `[AI Translate] Failed to save ${collection}#${id} (${locale}): ${message}`,
      )
      yield { type: 'error', message }
      return
    }

    payload.logger?.info?.(`[AI Translate] Saved translations for ${collection}#${id} (${locale}).`)
    yield { type: 'applied', locale }
  }

  payload.logger?.info?.(`[AI Translate] Completed translation for ${collection}#${id}.`)
  yield { type: 'done' }
}
