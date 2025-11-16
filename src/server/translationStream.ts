import { isPlainObject, type Payload } from 'payload'

import type {
  TranslateChunk,
  TranslateItem,
  TranslateLocaleRequestPayload,
  TranslateRequestPayload,
  TranslateStreamEvent,
} from './translationTypes.js'

import { splitLexicalText, toLexical } from '../utils/lexical.js'
import { getValueAtPath, MAX_CHARS_PER_CHUNK } from '../utils/localizedFields.js'
import { resolveCustomPrompt } from './customPrompt.js'
import { logDebug } from './debugSettings.js'
import {
  cloneWithoutDocumentMetadata,
  loadLocalizedDocument,
  stripDocumentMetadata,
} from './documentUtils.js'
import { cloneLocaleData, mergeStructuralData, setValueAtPath } from './localeStructure.js'
import { openAiTranslateTexts } from './openAiTranslationClient.js'
import { getStoredTarget } from './translationStateStore.js'

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

const MAX_CHARS_PER_BATCH = MAX_CHARS_PER_CHUNK * 2

type TranslationTask =
  | {
      chunk: TranslateChunk
      type: 'lexical'
    }
  | {
      chunks: TranslateChunk[]
      type: 'batch'
    }

function chunkCharacterLength(chunk: TranslateChunk): number {
  return chunk.reduce((total, item) => total + item.text.length, 0)
}

function isLargeLexicalChunk(chunk: TranslateChunk): boolean {
  return (
    chunk.length === 1 &&
    chunk[0]?.lexical &&
    typeof chunk[0].text === 'string' &&
    chunk[0].text.length > MAX_CHARS_PER_CHUNK
  )
}

function createTranslationTasks(chunks: TranslateChunk[]): TranslationTask[] {
  const tasks: TranslationTask[] = []
  let currentBatch: TranslateChunk[] = []
  let currentBatchChars = 0

  const flushBatch = () => {
    if (currentBatch.length) {
      tasks.push({ type: 'batch', chunks: currentBatch })
      currentBatch = []
      currentBatchChars = 0
    }
  }

  for (const chunk of chunks) {
    if (!Array.isArray(chunk) || !chunk.length) {
      continue
    }

    if (isLargeLexicalChunk(chunk)) {
      flushBatch()
      tasks.push({ type: 'lexical', chunk })
      continue
    }

    const chunkLength = chunkCharacterLength(chunk)
    if (currentBatch.length && currentBatchChars + chunkLength > MAX_CHARS_PER_BATCH) {
      flushBatch()
    }

    currentBatch.push(chunk)
    currentBatchChars += chunkLength
  }

  flushBatch()

  return tasks
}

async function translateLargeLexicalItem(
  item: TranslateItem,
  from: string,
  locale: string,
  options: { customPrompt?: string },
): Promise<string> {
  const segments = splitLexicalText(item.text, MAX_CHARS_PER_CHUNK)
  if (segments.length <= 1) {
    const [translated] = await openAiTranslateTexts([item.text], from, locale, {
      customPrompt: options.customPrompt,
    })
    return translated
  }

  const translatedSegments: string[] = []

  for (const segment of segments) {
    const [translated] = await openAiTranslateTexts([segment], from, locale, {
      customPrompt: options.customPrompt,
    })
    translatedSegments.push(translated)
  }

  return translatedSegments.join('')
}

async function translateChunk(
  payload: Payload,
  chunk: TranslateChunk,
  from: string,
  locale: string,
  options: { collection: string; customPrompt?: string; documentId: number | string },
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
    const translated = await openAiTranslateTexts(texts, from, locale, {
      customPrompt: options.customPrompt,
    })
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
        const [result] = await openAiTranslateTexts([item.text], from, locale, {
          customPrompt: options.customPrompt,
        })
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

async function translateChunkGroup(
  payload: Payload,
  chunks: TranslateChunk[],
  from: string,
  locale: string,
  options: { collection: string; customPrompt?: string; documentId: number | string },
): Promise<string[][]> {
  if (!chunks.length) {
    return []
  }

  const translateGroup = async (group: TranslateChunk[]): Promise<string[][]> => {
    const texts = group.flatMap((chunk) => chunk.map((item) => item.text))

    try {
      logDebug(payload, '[AI Translate] Sending chunk batch to OpenAI.', {
        chunkCount: group.length,
        collection: options.collection,
        documentId: options.documentId,
        from,
        locale,
        paths: group.map((chunk) => chunk.map((item) => item.path)),
        texts,
      })

      const translated = await openAiTranslateTexts(texts, from, locale, {
        customPrompt: options.customPrompt,
      })

      logDebug(payload, '[AI Translate] Received OpenAI translation batch.', {
        chunkCount: group.length,
        collection: options.collection,
        documentId: options.documentId,
        from,
        locale,
        paths: group.map((chunk) => chunk.map((item) => item.path)),
        translated,
      })

      const results: string[][] = []
      let offset = 0

      for (const chunk of group) {
        results.push(translated.slice(offset, offset + chunk.length))
        offset += chunk.length
      }

      return results
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'

      if (group.length === 1) {
        logDebug(
          payload,
          '[AI Translate] Chunk batch translation failed, attempting per-chunk fallback.',
          {
            chunkCount: group.length,
            collection: options.collection,
            documentId: options.documentId,
            error: message,
            from,
            locale,
            paths: group.map((chunk) => chunk.map((item) => item.path)),
          },
        )

        const translated = await translateChunk(payload, group[0] ?? [], from, locale, options)
        return [translated]
      }

      const midpoint = Math.max(1, Math.floor(group.length / 2))

      logDebug(
        payload,
        '[AI Translate] Chunk batch translation failed, splitting group for retry.',
        {
          chunkCount: group.length,
          collection: options.collection,
          documentId: options.documentId,
          error: message,
          from,
          locale,
          paths: group.map((chunk) => chunk.map((item) => item.path)),
        },
      )

      const firstHalf = await translateGroup(group.slice(0, midpoint))
      const secondHalf = await translateGroup(group.slice(midpoint))

      return [...firstHalf, ...secondHalf]
    }
  }

  return translateGroup(chunks)
}

function getTranslationLengthMismatch(chunk: TranslateChunk, translated: string[]): null | string {
  if (translated.length !== chunk.length) {
    return `Translator mismatch: expected ${chunk.length}, received ${translated.length}`
  }

  return null
}

function applyTranslatedValues(
  chunk: TranslateChunk,
  translated: string[],
  baseDoc: null | Record<string, unknown>,
  localeData: unknown,
): unknown {
  let nextLocaleData = localeData

  for (let index = 0; index < chunk.length; index += 1) {
    const item = chunk[index]
    const translatedText = translated[index]
    const templateValue = baseDoc ? getValueAtPath(baseDoc, item.path) : undefined
    const nextValue = item.lexical ? toLexical(translatedText, templateValue) : translatedText
    nextLocaleData = setValueAtPath(baseDoc, nextLocaleData, item.path, nextValue)
  }

  return nextLocaleData
}

export async function* streamTranslations(
  payload: Payload,
  input: TranslateRequestPayload,
): AsyncGenerator<TranslateStreamEvent> {
  const { from, locales } = input
  const isCollectionTarget = 'collection' in input && Boolean(input.collection)
  const targetLabel = isCollectionTarget
    ? `${input.collection}#${input.id}`
    : // @ts-expect-error -- Need to investigate
      `global:${input.global}`
  const collectionSlug = isCollectionTarget ? input.collection : undefined
  const documentId = isCollectionTarget ? input.id : undefined
  // @ts-expect-error -- Need to investigate
  const globalSlug = isCollectionTarget ? undefined : input.global
  const collectionLabel = collectionSlug ?? `global:${globalSlug}`
  const translationDocumentId = documentId ?? globalSlug ?? 'global'

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
    `[AI Translate] Starting translation for ${targetLabel} from ${from} to [${localeList}].`,
  )

  logDebug(payload, '[AI Translate] Preparing translation run.', {
    collection: 'collection' in input ? input.collection : undefined,
    documentId: 'id' in input ? input.id : undefined,
    from,
    global: 'global' in input ? input.global : undefined,
    locales: locales.map((locale) => ({
      chunks: locale.chunks.length,
      code: locale.code,
      items: countItems(locale.chunks),
      overrides: countOverrides(locale.overrides),
    })),
    totalItems,
  })

  // Fetch base document once (default locale) to preserve structural data such as blockType
  let baseDoc: null | Record<string, unknown> = null
  try {
    const doc = await loadLocalizedDocument(
      payload,
      isCollectionTarget
        ? {
            id: input.id,
            collection: input.collection,
            fallbackLocale: false,
            locale: from,
          }
        : {
            fallbackLocale: false,
            // @ts-expect-error -- Need to investigate
            global: input.global as string,
            locale: from,
          },
    )
    if (doc && typeof doc === 'object') {
      baseDoc = doc
      stripDocumentMetadata(baseDoc)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load base document.'
    yield { type: 'error', message }
    logDebug(payload, '[AI Translate] Failed to load base document.', {
      collection: 'collection' in input ? input.collection : undefined,
      documentId: 'id' in input ? input.id : undefined,
      error: message,
      from,
      global: 'global' in input ? input.global : undefined,
    })
    return
  }

  const storedEntry = getStoredTarget({
    collection: 'collection' in input ? input.collection : undefined,
    global: 'global' in input ? input.global : undefined,
  })
  const customPromptFn = storedEntry?.customPrompt
  const promptCache = new Map<string, string | undefined>()

  for (const localeEntry of locales) {
    const { chunks, code: locale } = localeEntry
    let existingLocaleDoc: null | Record<string, unknown> = null

    try {
      const localeDoc = await loadLocalizedDocument(
        payload,
        isCollectionTarget
          ? {
              id: documentId as number | string,
              collection: collectionSlug as string,
              fallbackLocale: true,
              locale,
            }
          : {
              fallbackLocale: true,
              global: globalSlug as string,
              locale,
            },
      )
      if (localeDoc && typeof localeDoc === 'object') {
        existingLocaleDoc = localeDoc
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

    if (!promptCache.has(locale)) {
      const promptData = baseDoc ?? existingLocaleDoc ?? {}
      const prompt = resolveCustomPrompt(payload, customPromptFn, promptData, {
        collection: collectionLabel,
        documentId: translationDocumentId,
        locale,
      })
      promptCache.set(locale, prompt)
    }

    const localePrompt = promptCache.get(locale)

    logDebug(payload, '[AI Translate] Starting locale translation.', {
      chunkCount: chunks.length,
      collection: collectionSlug,
      documentId: translationDocumentId,
      from,
      global: globalSlug,
      locale,
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
    const tasks = createTranslationTasks(chunks)

    for (const task of tasks) {
      if (task.type === 'lexical') {
        const chunk = task.chunk
        let translated: string[]

        try {
          logDebug(payload, '[AI Translate] Splitting large lexical item for translation.', {
            collection: collectionSlug,
            documentId: translationDocumentId,
            from,
            global: globalSlug,
            locale,
            path: chunk[0].path,
            textLength: chunk[0].text.length,
          })
          const translatedText = await translateLargeLexicalItem(chunk[0], from, locale, {
            customPrompt: localePrompt,
          })
          translated = [translatedText]
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to translate chunk'
          payload.logger?.error?.(
            `[AI Translate] OpenAI translation failed for ${targetLabel} (${locale}): ${message}`,
          )
          logDebug(payload, '[AI Translate] OpenAI translation failed for lexical chunk.', {
            collection: collectionSlug,
            documentId: translationDocumentId,
            error: message,
            from,
            global: globalSlug,
            locale,
            path: chunk[0]?.path,
          })
          yield { type: 'error', message }
          return
        }

        const mismatch = getTranslationLengthMismatch(chunk, translated)
        if (mismatch) {
          yield { type: 'error', message: mismatch }
          payload.logger?.error?.(
            `[AI Translate] Translation mismatch for ${targetLabel} (${locale}).`,
          )
          logDebug(payload, '[AI Translate] Translation length mismatch.', {
            collection: collectionSlug,
            documentId: translationDocumentId,
            expected: chunk.length,
            from,
            global: globalSlug,
            locale,
            paths: chunk.map((item) => item.path),
            received: translated.length,
          })
          return
        }

        localeData = applyTranslatedValues(chunk, translated, baseDoc, localeData)
        completed += chunk.length
        yield { type: 'progress', completed, locale, total: localeTotalItems }
        continue
      }

      try {
        const translatedChunks = await translateChunkGroup(payload, task.chunks, from, locale, {
          collection: collectionLabel,
          customPrompt: localePrompt,
          documentId: translationDocumentId,
        })

        for (let index = 0; index < task.chunks.length; index += 1) {
          const chunk = task.chunks[index]
          const translated = translatedChunks[index] ?? []
          const mismatch = getTranslationLengthMismatch(chunk, translated)

          if (mismatch) {
            yield { type: 'error', message: mismatch }
            payload.logger?.error?.(
              `[AI Translate] Translation mismatch for ${targetLabel} (${locale}).`,
            )
            logDebug(payload, '[AI Translate] Translation length mismatch.', {
              collection: collectionSlug,
              documentId: translationDocumentId,
              expected: chunk.length,
              from,
              global: globalSlug,
              locale,
              paths: chunk.map((item) => item.path),
              received: translated.length,
            })
            return
          }

          localeData = applyTranslatedValues(chunk, translated, baseDoc, localeData)
          completed += chunk.length
          yield { type: 'progress', completed, locale, total: localeTotalItems }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to translate chunk'
        payload.logger?.error?.(
          `[AI Translate] OpenAI translation failed for ${targetLabel} (${locale}): ${message}`,
        )
        logDebug(payload, '[AI Translate] OpenAI translation failed for chunk batch.', {
          collection: collectionSlug,
          documentId: translationDocumentId,
          error: message,
          from,
          global: globalSlug,
          locale,
          paths: task.chunks.map((chunk) => chunk.map((item) => item.path)),
        })
        yield { type: 'error', message }
        return
      }
    }

    if (overrideItems.length) {
      for (const override of overrideItems) {
        const templateValue = baseDoc ? getValueAtPath(baseDoc, override.path) : undefined
        const nextValue = override.lexical ? toLexical(override.text, templateValue) : override.text
        localeData = setValueAtPath(baseDoc, localeData, override.path, nextValue)
        completed += 1
        logDebug(payload, '[AI Translate] Applied override value.', {
          collection: collectionSlug,
          documentId: translationDocumentId,
          from,
          global: globalSlug,
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
      const saveData = cloneWithoutDocumentMetadata(localeData) as Record<string, unknown>

      if (isCollectionTarget) {
        await payload.update({
          id: documentId as number | string,
          collection: collectionSlug as string,
          data: saveData,
          locale,
          overrideAccess: true,
        })
      } else {
        await payload.updateGlobal({
          slug: globalSlug as string,
          data: saveData,
          locale,
          overrideAccess: true,
        })
      }
      logDebug(payload, '[AI Translate] Saved locale document.', {
        collection: collectionSlug,
        documentId: translationDocumentId,
        from,
        global: globalSlug,
        locale,
        totalItems: localeTotalItems,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to update locale ${locale}`
      payload.logger?.error?.(
        `[AI Translate] Failed to save ${targetLabel} (${locale}): ${message}`,
      )
      logDebug(payload, '[AI Translate] Failed to save locale document.', {
        collection: collectionSlug,
        documentId: translationDocumentId,
        error: message,
        from,
        global: globalSlug,
        locale,
      })
      yield { type: 'error', message }
      return
    }

    payload.logger?.info?.(`[AI Translate] Saved translations for ${targetLabel} (${locale}).`)
    yield { type: 'applied', locale }
  }

  payload.logger?.info?.(`[AI Translate] Completed translation for ${targetLabel}.`)
  yield { type: 'done' }
}
