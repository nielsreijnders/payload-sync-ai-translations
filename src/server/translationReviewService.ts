import type { Payload, PayloadHandler } from 'payload'

import type {
  TranslateReviewLocale,
  TranslateReviewMismatch,
  TranslateReviewRequestPayload,
  TranslateReviewResponse,
  TranslateReviewSuggestion,
} from './translationTypes.js'

import { stripLexicalMarkers } from '../utils/lexical.js'
import { extractPlainText, getValueAtPath, MAX_CHARS_PER_CHUNK } from '../utils/localizedFields.js'
import {
  type MissingInformationCheckInput,
  openAiDetectMissingInformation,
  openAiTranslateTexts,
} from './openAiTranslationClient.js'
import { logDebug } from './debugSettings.js'
import { resolveCustomPrompt } from './customPrompt.js'
import { getStoredTarget } from './translationStateStore.js'
import { loadLocalizedDocument, stripDocumentMetadata } from './documentUtils.js'

type TranslateSuggestionInput = {
  index: number
  text: string
}

function chunkSuggestionInputs(entries: TranslateSuggestionInput[]): TranslateSuggestionInput[][] {
  const chunks: TranslateSuggestionInput[][] = []
  let current: TranslateSuggestionInput[] = []
  let total = 0

  for (const entry of entries) {
    const length = entry.text.length
    if (current.length && total + length > MAX_CHARS_PER_CHUNK) {
      chunks.push(current)
      current = [entry]
      total = length
    } else {
      current.push(entry)
      total += length
    }
  }

  if (current.length) {
    chunks.push(current)
  }

  return chunks
}

function isTranslateItem(value: unknown): value is TranslateReviewRequestPayload['items'][number] {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { path?: unknown }).path === 'string' &&
    typeof (value as { text?: unknown }).text === 'string'
  )
}

function areTranslateItems(value: unknown): value is TranslateReviewRequestPayload['items'] {
  return Array.isArray(value) && value.every(isTranslateItem)
}

function parseBody(body: unknown): TranslateReviewRequestPayload {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Invalid JSON body')
  }

  const candidate = body as Record<string, unknown>
  const from = candidate.from
  const collection = candidate.collection
  const global = candidate.global
  const identifier = candidate.id
  const locales = candidate.locales
  const items = candidate.items

  if (typeof from !== 'string' || !from) {
    throw new Error('Missing "from" locale')
  }

  const hasCollection = typeof collection === 'string' && Boolean(collection)
  const hasGlobal = typeof global === 'string' && Boolean(global)

  if (!hasCollection && !hasGlobal) {
    throw new Error('Missing "collection" or "global" slug')
  }

  if (hasCollection && hasGlobal) {
    throw new Error('Provide either a collection slug or a global slug, not both')
  }

  if (hasCollection) {
    if (typeof identifier !== 'string' && typeof identifier !== 'number') {
      throw new Error('Missing document "id"')
    }

    if (typeof identifier === 'string' && !identifier) {
      throw new Error('Missing document "id"')
    }
  }

  if (!Array.isArray(locales) || locales.some((locale) => typeof locale !== 'string' || !locale)) {
    throw new Error('Expected "locales" to be an array of locale codes')
  }

  if (!areTranslateItems(items)) {
    throw new Error('Expected "items" to be an array of translation items')
  }

  const uniqueLocales = Array.from(new Set(locales as string[]))

  if (!uniqueLocales.length) {
    throw new Error('No target locales provided')
  }

  const base = hasCollection
    ? { collection: collection.trim(), id: identifier }
    : { global: (global as string).trim() }

  return {
    ...base,
    from,
    items,
    locales: uniqueLocales,
  }
}

export async function generateTranslationReview(
  payload: Payload,
  request: TranslateReviewRequestPayload,
): Promise<TranslateReviewResponse> {
  const locales: TranslateReviewLocale[] = []

  const isCollectionTarget = 'collection' in request && Boolean(request.collection)
  const targetLabel = isCollectionTarget
    ? `${request.collection}#${request.id}`
    : `global:${request.global}`

  logDebug(payload, '[AI Translate] Generating translation review.', {
    collection: request.collection,
    documentId: request.id,
    global: request.global,
    from: request.from,
    localeCount: request.locales.length,
    itemCount: request.items.length,
  })

  let baseDoc: null | Record<string, unknown> = null

  try {
    const doc = await loadLocalizedDocument(
      payload,
      isCollectionTarget
        ? {
            id: request.id as number | string,
            collection: request.collection as string,
            fallbackLocale: false,
            locale: request.from,
          }
        : {
            global: request.global as string,
            fallbackLocale: false,
            locale: request.from,
          },
    )

    if (doc && typeof doc === 'object') {
      baseDoc = doc as Record<string, unknown>
      stripDocumentMetadata(baseDoc)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load base document.'
    throw new Error(message)
  }

  logDebug(payload, '[AI Translate] Loaded base document for review.', {
    collection: request.collection,
    documentId: request.id,
    global: request.global,
    from: request.from,
    hasBaseDoc: Boolean(baseDoc),
  })

  const storedEntry = getStoredTarget({ collection: request.collection, global: request.global })
  const customPromptFn = storedEntry?.customPrompt
  const promptCache = new Map<string, string | undefined>()

  for (const localeCode of request.locales) {
    let localeDoc: null | Record<string, unknown> = null

    try {
      const result = await loadLocalizedDocument(
        payload,
        isCollectionTarget
          ? {
              id: request.id as number | string,
              collection: request.collection as string,
              fallbackLocale: false,
              locale: localeCode,
            }
          : {
              global: request.global as string,
              fallbackLocale: false,
              locale: localeCode,
            },
      )

      if (result && typeof result === 'object') {
        localeDoc = result as Record<string, unknown>
        stripDocumentMetadata(localeDoc)
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Failed to load locale data for ${localeCode}.`
      throw new Error(message)
    }

    logDebug(payload, '[AI Translate] Loaded locale document for review.', {
      collection: request.collection,
      documentId: request.id,
      global: request.global,
      locale: localeCode,
      hasLocaleDoc: Boolean(localeDoc),
    })

    const translateIndexes = new Set<number>()
    const mismatches: TranslateReviewMismatch[] = []
    const aiInputs: MissingInformationCheckInput[] = []
    const existingByIndex = new Map<number, string>()
    let existingCount = 0

    const translateCandidates: TranslateSuggestionInput[] = []

    request.items.forEach((item, index) => {
      const defaultText = item.lexical ? stripLexicalMarkers(item.text) : item.text
      const existingValue = localeDoc
        ? getValueAtPath(localeDoc, item.path, { base: baseDoc })
        : undefined
      const existingText = extractPlainText(existingValue) ?? ''

      if (!existingText) {
        translateIndexes.add(index)
        translateCandidates.push({ index, text: item.text })
        return
      }

      existingCount += 1
      existingByIndex.set(index, existingText)
      aiInputs.push({
        defaultText,
        index,
        translatedText: existingText,
      })
    })

    if (aiInputs.length) {
      try {
        logDebug(payload, '[AI Translate] Checking existing translations for missing information.', {
          collection: request.collection,
          documentId: request.id,
          locale: localeCode,
          inputCount: aiInputs.length,
        })
        const results = await openAiDetectMissingInformation(aiInputs, request.from, localeCode)
        logDebug(payload, '[AI Translate] Missing information check results.', {
          collection: request.collection,
          documentId: request.id,
          locale: localeCode,
          issues: results.filter((result) => result.missing).map((result) => ({
            index: result.index,
            reason: result.reason,
          })),
        })
        for (const result of results) {
          if (!result.missing) {
            continue
          }

          translateIndexes.add(result.index)

          const sourceItem = request.items[result.index]
          mismatches.push({
            defaultText: sourceItem?.lexical
              ? stripLexicalMarkers(sourceItem.text)
              : (sourceItem?.text ?? ''),
            existingText: existingByIndex.get(result.index) ?? '',
            index: result.index,
            path: sourceItem?.path ?? '',
            reason: result.reason || 'Missing information detected.',
          })
          if (sourceItem) {
            translateCandidates.push({ index: result.index, text: sourceItem.text })
          }
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Validation of existing translations failed.'
        throw new Error(message)
      }
    }

    const sortedIndexes = Array.from(translateIndexes).sort((a, b) => a - b)

    let suggestions: TranslateReviewSuggestion[] = []

    if (translateCandidates.length) {
      try {
        const uniqueCandidates = new Map<number, string>()
        for (const entry of translateCandidates) {
          if (!uniqueCandidates.has(entry.index)) {
            uniqueCandidates.set(entry.index, entry.text)
          }
        }

        const orderedCandidates = sortedIndexes
          .map((index) =>
            uniqueCandidates.has(index) ? { index, text: uniqueCandidates.get(index) ?? '' } : null,
          )
          .filter((entry): entry is TranslateSuggestionInput => Boolean(entry))

        const chunks = chunkSuggestionInputs(orderedCandidates)

        logDebug(payload, '[AI Translate] Preparing suggestion translations.', {
          collection: request.collection,
          documentId: request.id,
          locale: localeCode,
          chunkCount: chunks.length,
          totalSuggestions: orderedCandidates.length,
        })

        if (!promptCache.has(localeCode)) {
          const promptData = baseDoc ?? localeDoc ?? {}
          const prompt = resolveCustomPrompt(payload, customPromptFn, promptData, {
            collection: request.collection,
            documentId: request.id,
            locale: localeCode,
          })
          promptCache.set(localeCode, prompt)
        }

        const localePrompt = promptCache.get(localeCode)

        const collected: TranslateReviewSuggestion[] = []
        for (const chunk of chunks) {
          const translated = await openAiTranslateTexts(
            chunk.map((item) => item.text),
            request.from,
            localeCode,
            { customPrompt: localePrompt },
          )

          chunk.forEach((item, chunkIndex) => {
            const text = translated[chunkIndex] ?? ''
            collected.push({ index: item.index, text })
          })
        }

        suggestions = collected
        logDebug(payload, '[AI Translate] Generated AI suggestions for review.', {
          collection: request.collection,
          documentId: request.id,
          locale: localeCode,
          suggestionCount: suggestions.length,
        })
      } catch (_error) {
        suggestions = []
      }
    }

    locales.push({
      code: localeCode,
      existingCount,
      mismatches,
      suggestions: suggestions.length ? suggestions : undefined,
      translateIndexes: sortedIndexes,
    })
  }

  return { locales }
}

export function createAiTranslateReviewHandler(): PayloadHandler {
  return async (req) => {
    try {
      const payload = req.payload
      if (!payload) {
        throw new Error('Payload instance is not available on the request')
      }

      // @ts-ignore oopsie for now
      const parsed = parseBody(await req.json())

      logDebug(payload, '[AI Translate] Parsed translation review request.', {
        collection: parsed.collection,
        documentId: parsed.id,
        from: parsed.from,
        localeCount: parsed.locales.length,
        itemCount: parsed.items.length,
      })
      const review = await generateTranslationReview(payload, parsed)

      return Response.json(review)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request body'
      return Response.json({ message }, { status: 400 })
    }
  }
}
