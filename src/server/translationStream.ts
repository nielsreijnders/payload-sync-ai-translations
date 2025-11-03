import type { Payload } from 'payload'

import type {
  TranslateChunk,
  TranslateLocaleRequestPayload,
  TranslateRequestPayload,
  TranslateStreamEvent,
} from './translationTypes.js'

import { toLexical } from '../utils/lexical.js'
import { getValueAtPath } from '../utils/localizedFields.js'
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

    if (typeof localeData !== 'object' || localeData === null || Array.isArray(localeData)) {
      localeData = {}
    }

    delete (localeData as Record<string, unknown>).id
    delete (localeData as Record<string, unknown>)._id
    delete (localeData as Record<string, unknown>).createdAt
    delete (localeData as Record<string, unknown>).updatedAt

    if (baseDoc) {
      localeData = mergeStructuralData(baseDoc, localeData)
      delete (localeData as Record<string, unknown>).id
      delete (localeData as Record<string, unknown>)._id
      delete (localeData as Record<string, unknown>).createdAt
      delete (localeData as Record<string, unknown>).updatedAt
    }

    let completed = 0

    for (const chunk of chunks) {
      const texts = chunk.map((item) => item.text)

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

      if (translated.length !== chunk.length) {
        yield {
          type: 'error',
          message: `Translator mismatch: expected ${chunk.length}, received ${translated.length}`,
        }
        payload.logger?.error?.(
          `[AI Translate] Translation mismatch for ${collection}#${id} (${locale}).`,
        )
        return
      }

      for (let index = 0; index < chunk.length; index += 1) {
        const item = chunk[index]
        const translatedText = translated[index]
        const templateValue = baseDoc ? getValueAtPath(baseDoc, item.path) : undefined
        const nextValue = item.lexical ? toLexical(translatedText, templateValue) : translatedText
        localeData = setValueAtPath(baseDoc, localeData, item.path, nextValue)
      }

      completed += chunk.length
      yield { type: 'progress', completed, locale, total: localeTotalItems }
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
