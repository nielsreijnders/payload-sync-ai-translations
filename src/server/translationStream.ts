import { isPlainObject, type Payload } from 'payload'

import type {
  TranslateChunk,
  TranslateItem,
  TranslateLocaleRequestPayload,
  TranslateRequestPayload,
  TranslateStreamEvent,
} from './translationTypes.js'

import { splitLexicalText, toLexical } from '../utils/lexical.js'
import { MAX_CHARS_PER_CHUNK, getValueAtPath } from '../utils/localizedFields.js'
import { stripDocumentMetadata } from './documentUtils.js'
import { logDebug } from './debugSettings.js'
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

async function translateLargeLexicalItem(
  item: TranslateItem,
  from: string,
  locale: string,
): Promise<string> {
  const segments = splitLexicalText(item.text, MAX_CHARS_PER_CHUNK)
  if (segments.length <= 1) {
    const [translated] = await openAiTranslateTexts([item.text], from, locale)
    return translated
  }

  const translatedSegments: string[] = []

  for (const segment of segments) {
    const [translated] = await openAiTranslateTexts([segment], from, locale)
    translatedSegments.push(translated)
  }

  return translatedSegments.join('')
}

async function translateChunk(
  payload: Payload,
  chunk: TranslateChunk,
  from: string,
  locale: string,
  options: { collection: string; documentId: string | number },
): Promise<string[]> {
  const texts = chunk.map((item) => item.text)

  try {
    logDebug(payload, '[AI Translate] Sending chunk to OpenAI.', {
      collection: options.collection,
      documentId: options.documentId,
      from,
      locale,
      paths: chunk.map((item) => item.path),
      texts,
    })
    const translated = await openAiTranslateTexts(texts, from, locale)
    logDebug(payload, '[AI Translate] Received OpenAI translation.', {
      collection: options.collection,
      documentId: options.documentId,
      from,
      locale,
      paths: chunk.map((item) => item.path),
      translated,
    })
    return translated
  } catch (error) {
    if (chunk.length <= 1) {
      throw error
    }

    logDebug(payload, '[AI Translate] Chunk translation failed, attempting per-item fallback.', {
      collection: options.collection,
      documentId: options.documentId,
      error: error instanceof Error ? error.message : 'Unknown error',
      from,
      locale,
      paths: chunk.map((item) => item.path),
    })

    const translated: string[] = []

    for (const item of chunk) {
      try {
        const [result] = await openAiTranslateTexts([item.text], from, locale)
        translated.push(result)
      } catch (singleError) {
        logDebug(payload, '[AI Translate] Per-item fallback translation failed.', {
          collection: options.collection,
          documentId: options.documentId,
          error: singleError instanceof Error ? singleError.message : 'Unknown error',
          from,
          locale,
          path: item.path,
        })
        throw singleError
      }
    }

    logDebug(payload, '[AI Translate] Per-item fallback translation succeeded.', {
      collection: options.collection,
      documentId: options.documentId,
      from,
      locale,
      paths: chunk.map((item) => item.path),
      translated,
    })

    return translated
  }
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

  logDebug(payload, '[AI Translate] Preparing translation run.', {
    collection,
    documentId: id,
    from,
    locales: locales.map((locale) => ({
      code: locale.code,
      chunks: locale.chunks.length,
      items: countItems(locale.chunks),
      overrides: countOverrides(locale.overrides),
    })),
    totalItems,
  })

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
    logDebug(payload, '[AI Translate] Failed to load base document.', {
      collection,
      documentId: id,
      error: message,
      from,
    })
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

    logDebug(payload, '[AI Translate] Starting locale translation.', {
      collection,
      documentId: id,
      from,
      locale,
      chunkCount: chunks.length,
      overrideCount: overrideItems.length,
    })

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
      let translated: string[]
      if (
        chunk.length === 1 &&
        chunk[0]?.lexical &&
        typeof chunk[0].text === 'string' &&
        chunk[0].text.length > MAX_CHARS_PER_CHUNK
      ) {
        try {
          logDebug(payload, '[AI Translate] Splitting large lexical item for translation.', {
            collection,
            documentId: id,
            from,
            locale,
            path: chunk[0].path,
            textLength: chunk[0].text.length,
          })
          const translatedText = await translateLargeLexicalItem(chunk[0], from, locale)
          translated = [translatedText]
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to translate chunk'
          payload.logger?.error?.(
            `[AI Translate] OpenAI translation failed for ${collection}#${id} (${locale}): ${message}`,
          )
          logDebug(payload, '[AI Translate] OpenAI translation failed for lexical chunk.', {
            collection,
            documentId: id,
            error: message,
            from,
            locale,
            path: chunk[0]?.path,
          })
          yield { type: 'error', message }
          return
        }
      } else {
        try {
          translated = await translateChunk(payload, chunk, from, locale, {
            collection,
            documentId: id,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to translate chunk'
          payload.logger?.error?.(
            `[AI Translate] OpenAI translation failed for ${collection}#${id} (${locale}): ${message}`,
          )
          logDebug(payload, '[AI Translate] OpenAI translation failed for chunk.', {
            collection,
            documentId: id,
            error: message,
            from,
            locale,
            paths: chunk.map((item) => item.path),
          })
          yield { type: 'error', message }
          return
        }
      }

      if (translated.length !== chunk.length) {
        yield {
          type: 'error',
          message: `Translator mismatch: expected ${chunk.length}, received ${translated.length}`,
        }
        payload.logger?.error?.(
          `[AI Translate] Translation mismatch for ${collection}#${id} (${locale}).`,
        )
        logDebug(payload, '[AI Translate] Translation length mismatch.', {
          collection,
          documentId: id,
          expected: chunk.length,
          from,
          locale,
          paths: chunk.map((item) => item.path),
          received: translated.length,
        })
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
        logDebug(payload, '[AI Translate] Applied override value.', {
          collection,
          documentId: id,
          from,
          locale,
          path: override.path,
        })
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
      logDebug(payload, '[AI Translate] Saved locale document.', {
        collection,
        documentId: id,
        from,
        locale,
        totalItems: localeTotalItems,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to update locale ${locale}`
      payload.logger?.error?.(
        `[AI Translate] Failed to save ${collection}#${id} (${locale}): ${message}`,
      )
      logDebug(payload, '[AI Translate] Failed to save locale document.', {
        collection,
        documentId: id,
        error: message,
        from,
        locale,
      })
      yield { type: 'error', message }
      return
    }

    payload.logger?.info?.(`[AI Translate] Saved translations for ${collection}#${id} (${locale}).`)
    yield { type: 'applied', locale }
  }

  payload.logger?.info?.(`[AI Translate] Completed translation for ${collection}#${id}.`)
  yield { type: 'done' }
}
