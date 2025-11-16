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
import { resolveCustomPrompt } from './customPrompt.js'
import { logDebug } from './debugSettings.js'
import { stripDocumentMetadata } from './documentUtils.js'
import {
  type MissingInformationCheckInput,
  openAiDetectMissingInformation,
  openAiTranslateTexts,
} from './openAiTranslationClient.js'
import { getStoredCollection } from './translationStateStore.js'

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

  const hasCollection = typeof collection === 'string' && collection.length > 0
  const hasGlobal = typeof global === 'string' && global.length > 0

  if (!hasCollection && !hasGlobal) {
    throw new Error('Missing "collection" or "global" slug')
  }

  if (hasCollection) {
    if (typeof identifier !== 'string' && typeof identifier !== 'number') {
      throw new Error('Missing document "id"')
    }

    if (typeof identifier === 'string' && !identifier) {
      throw new Error('Missing document "id"')
    }
  }

  if (!hasCollection && identifier !== undefined) {
    if (typeof identifier !== 'string' && typeof identifier !== 'number') {
      throw new Error('Invalid document "id"')
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

  return hasCollection
    ? {
        id: identifier as number | string,
        collection,
        from,
        items,
        locales: uniqueLocales,
      }
    : {
        id: identifier as number | string | undefined,
        from,
        global: global as string,
        items,
        locales: uniqueLocales,
      }
}

export async function generateTranslationReview(
  payload: Payload,
  request: TranslateReviewRequestPayload,
): Promise<TranslateReviewResponse> {
  const locales: TranslateReviewLocale[] = []

  logDebug(payload, '[AI Translate] Generating translation review.', {
    collection: request.collection ?? request.global,
    documentId: request.id,
    from: request.from,
    itemCount: request.items.length,
    localeCount: request.locales.length,
  })

  let baseDoc: null | Record<string, unknown> = null

  try {
    const doc = request.collection
      ? await payload.findByID({
          id: request.id,
          collection: request.collection,
          depth: 0,
          fallbackLocale: false,
          locale: request.from,
        })
      : await payload.findGlobal({
          slug: request.global,
          depth: 0,
          fallbackLocale: false,
          locale: request.from,
        })

    if (doc && typeof doc === 'object') {
      baseDoc = doc as Record<string, unknown>
      stripDocumentMetadata(baseDoc)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load base document.'
    throw new Error(message)
  }

  logDebug(payload, '[AI Translate] Loaded base document for review.', {
    collection: request.collection ?? request.global,
    documentId: request.id,
    from: request.from,
    hasBaseDoc: Boolean(baseDoc),
  })

  const storedCollection = getStoredCollection(request.collection ?? request.global)
  const customPromptFn = storedCollection?.customPrompt
  const promptCache = new Map<string, string | undefined>()

  for (const localeCode of request.locales) {
    let localeDoc: null | Record<string, unknown> = null

    try {
      const result = request.collection
        ? await payload.findByID({
            id: request.id,
            collection: request.collection,
            depth: 0,
            fallbackLocale: false,
            locale: localeCode,
          })
        : await payload.findGlobal({
            slug: request.global,
            depth: 0,
            fallbackLocale: false,
            locale: localeCode,
          })

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
      collection: request.collection ?? request.global,
      documentId: request.id,
      hasLocaleDoc: Boolean(localeDoc),
      locale: localeCode,
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
        logDebug(
          payload,
          '[AI Translate] Checking existing translations for missing information.',
          {
            collection: request.collection,
            documentId: request.id,
            inputCount: aiInputs.length,
            locale: localeCode,
          },
        )
        const results = await openAiDetectMissingInformation(aiInputs, request.from, localeCode)
        logDebug(payload, '[AI Translate] Missing information check results.', {
          collection: request.collection,
          documentId: request.id,
          issues: results
            .filter((result) => result.missing)
            .map((result) => ({
              index: result.index,
              reason: result.reason,
            })),
          locale: localeCode,
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
          chunkCount: chunks.length,
          collection: request.collection,
          documentId: request.id,
          locale: localeCode,
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
        itemCount: parsed.items.length,
        localeCount: parsed.locales.length,
      })
      const review = await generateTranslationReview(payload, parsed)

      return Response.json(review)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request body'
      return Response.json({ message }, { status: 400 })
    }
  }
}
