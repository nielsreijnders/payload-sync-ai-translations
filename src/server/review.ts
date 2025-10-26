import type { Payload, PayloadHandler } from 'payload'

import type {
  TranslateReviewLocale,
  TranslateReviewMismatch,
  TranslateReviewRequestPayload,
  TranslateReviewResponse,
  TranslateReviewSuggestion,
} from './types.js'

import { extractPlainText, getValueAtPath, MAX_CHARS_PER_CHUNK } from '../utils/localizedFields.js'
import { lexicalValueToHTML } from './lexical.js'
import {
  type MissingInformationCheckInput,
  openAiDetectMissingInformation,
  openAiTranslateTexts,
} from './openai.js'

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
  const identifier = candidate.id
  const locales = candidate.locales
  const items = candidate.items

  if (typeof from !== 'string' || !from) {
    throw new Error('Missing "from" locale')
  }

  if (typeof collection !== 'string' || !collection) {
    throw new Error('Missing "collection" slug')
  }

  if (typeof identifier !== 'string' && typeof identifier !== 'number') {
    throw new Error('Missing document "id"')
  }

  if (typeof identifier === 'string' && !identifier) {
    throw new Error('Missing document "id"')
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

  return {
    id: identifier,
    collection,
    from,
    items,
    locales: uniqueLocales,
  }
}

export async function generateTranslationReview(
  payload: Payload,
  request: TranslateReviewRequestPayload,
): Promise<TranslateReviewResponse> {
  let baseDoc: null | Record<string, unknown> = null

  try {
    const result = await payload.findByID({
      id: request.id,
      collection: request.collection,
      depth: 0,
      fallbackLocale: false,
      locale: request.from,
    })

    if (result && typeof result === 'object') {
      baseDoc = result as Record<string, unknown>
    }
  } catch {
    baseDoc = null
  }

  const defaultLexicalHTMLByIndex = new Map<number, string>()

  if (baseDoc) {
    for (let index = 0; index < request.items.length; index += 1) {
      const item = request.items[index]
      if (!item?.lexical) {
        continue
      }

      const value = getValueAtPath(baseDoc, item.path)
      const html = await lexicalValueToHTML(value)
      if (html) {
        defaultLexicalHTMLByIndex.set(index, html)
      }
    }
  }

  const locales: TranslateReviewLocale[] = []

  for (const localeCode of request.locales) {
    let localeDoc: null | Record<string, unknown> = null

    try {
      const result = await payload.findByID({
        id: request.id,
        collection: request.collection,
        depth: 0,
        fallbackLocale: false,
        locale: localeCode,
      })

      if (result && typeof result === 'object') {
        localeDoc = result as Record<string, unknown>
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Failed to load locale data for ${localeCode}.`
      throw new Error(message)
    }

    const translateIndexes = new Set<number>()
    const mismatches: TranslateReviewMismatch[] = []
    const aiInputs: MissingInformationCheckInput[] = []
    const existingByIndex = new Map<number, string>()
    let existingCount = 0

    const translateCandidates: TranslateSuggestionInput[] = []

    request.items.forEach((item, index) => {
      const existingValue = localeDoc ? getValueAtPath(localeDoc, item.path) : undefined
      const existingText = extractPlainText(existingValue) ?? ''

      if (!existingText) {
        translateIndexes.add(index)
        const sourceText = item.lexical ? defaultLexicalHTMLByIndex.get(index) ?? item.text : item.text
        translateCandidates.push({ index, text: sourceText })
        return
      }

      existingCount += 1
      existingByIndex.set(index, existingText)
      aiInputs.push({
        defaultText: item.text,
        index,
        translatedText: existingText,
      })
    })

    if (aiInputs.length) {
      try {
        const results = await openAiDetectMissingInformation(aiInputs, request.from, localeCode)
        for (const result of results) {
          if (!result.missing) {
            continue
          }

          translateIndexes.add(result.index)

          const sourceItem = request.items[result.index]
          mismatches.push({
            defaultText: sourceItem?.text ?? '',
            existingText: existingByIndex.get(result.index) ?? '',
            index: result.index,
            path: sourceItem?.path ?? '',
            reason: result.reason || 'Missing information detected.',
          })
          if (sourceItem) {
            const sourceText = sourceItem.lexical
              ? defaultLexicalHTMLByIndex.get(result.index) ?? sourceItem.text
              : sourceItem.text
            translateCandidates.push({ index: result.index, text: sourceText })
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
            uniqueCandidates.has(index)
              ? { index, text: uniqueCandidates.get(index) ?? '' }
              : null,
          )
          .filter((entry): entry is TranslateSuggestionInput => Boolean(entry))

        const chunks = chunkSuggestionInputs(orderedCandidates)

        const collected: TranslateReviewSuggestion[] = []
        for (const chunk of chunks) {
          const translated = await openAiTranslateTexts(
            chunk.map((item) => item.text),
            request.from,
            localeCode,
          )

          chunk.forEach((item, chunkIndex) => {
            const text = translated[chunkIndex] ?? ''
            collected.push({ index: item.index, text })
          })
        }

        suggestions = collected
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
      const review = await generateTranslationReview(payload, parsed)

      return Response.json(review)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request body'
      return Response.json({ message }, { status: 400 })
    }
  }
}
