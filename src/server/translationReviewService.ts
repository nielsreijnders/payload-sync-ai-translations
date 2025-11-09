import type { Payload, PayloadHandler } from 'payload'

import type {
  TranslateReviewLocale,
  TranslateReviewMismatch,
  TranslateReviewRequestPayload,
  TranslateReviewResponse,
  TranslateReviewSuggestion,
} from './translationTypes.js'

import { splitLexicalText, stripLexicalMarkers } from '../utils/lexical.js'
import { extractPlainText, getValueAtPath, MAX_CHARS_PER_CHUNK } from '../utils/localizedFields.js'
import {
  type MissingInformationCheckInput,
  openAiDetectMissingInformation,
  openAiTranslateTexts,
} from './openAiTranslationClient.js'

type TranslateSuggestionInput = {
  index: number
  lexical: boolean
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
  const locales: TranslateReviewLocale[] = []

  let baseDoc: null | Record<string, unknown> = null

  try {
    const doc = await payload.findByID({
      id: request.id,
      collection: request.collection,
      depth: 0,
      fallbackLocale: false,
      locale: request.from,
    })

    if (doc && typeof doc === 'object') {
      baseDoc = doc as Record<string, unknown>
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load base document.'
    throw new Error(message)
  }

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
      const defaultText = item.lexical ? stripLexicalMarkers(item.text) : item.text
      const existingValue = localeDoc
        ? getValueAtPath(localeDoc, item.path, { base: baseDoc })
        : undefined
      const existingText = extractPlainText(existingValue) ?? ''

      if (!existingText) {
        translateIndexes.add(index)
        translateCandidates.push({ index, lexical: item.lexical, text: item.text })
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
        const results = await openAiDetectMissingInformation(aiInputs, request.from, localeCode)
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
          translateCandidates.push({
            index: result.index,
            lexical: Boolean(sourceItem?.lexical),
            text: sourceItem.text,
          })
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
        const uniqueCandidates = new Map<number, TranslateSuggestionInput>()
        for (const entry of translateCandidates) {
          if (!uniqueCandidates.has(entry.index)) {
            uniqueCandidates.set(entry.index, entry)
          }
        }

        const orderedCandidates = sortedIndexes
          .map((index) => (uniqueCandidates.has(index) ? uniqueCandidates.get(index) ?? null : null))
          .filter((entry): entry is TranslateSuggestionInput => Boolean(entry))

        const chunks = chunkSuggestionInputs(orderedCandidates)

        const collected: TranslateReviewSuggestion[] = []
        for (const chunk of chunks) {
          const expanded = chunk.flatMap((item, chunkIndex) => {
            if (item.lexical && item.text.length > MAX_CHARS_PER_CHUNK) {
              const segments = splitLexicalText(item.text, MAX_CHARS_PER_CHUNK)
              if (segments.length) {
                return segments.map((segment, segmentIndex) => ({
                  chunkIndex,
                  partIndex: segmentIndex,
                  parts: segments.length,
                  text: segment,
                }))
              }
            }

            return [{ chunkIndex, partIndex: 0, parts: 1, text: item.text }]
          })

          const translated = await openAiTranslateTexts(
            expanded.map((entry) => entry.text),
            request.from,
            localeCode,
          )

          if (translated.length !== expanded.length) {
            throw new Error('Translator mismatch while generating suggestions.')
          }

          const combined = new Map<number, string>()
          const buffers = new Map<number, { parts: string[]; total: number }>()

          expanded.forEach((entry, entryIndex) => {
            const translatedText = translated[entryIndex] ?? ''

            if (entry.parts === 1) {
              combined.set(entry.chunkIndex, translatedText)
              return
            }

            let buffer = buffers.get(entry.chunkIndex)
            if (!buffer) {
              buffer = { parts: new Array(entry.parts).fill(''), total: entry.parts }
              buffers.set(entry.chunkIndex, buffer)
            }

            buffer.parts[entry.partIndex] = translatedText

            if (buffer.parts.every((part) => part.length > 0)) {
              combined.set(entry.chunkIndex, buffer.parts.join(''))
            }
          })

          chunk.forEach((item, chunkIndex) => {
            if (!combined.has(chunkIndex)) {
              throw new Error('Translator response incomplete while generating suggestions.')
            }

            const text = combined.get(chunkIndex) ?? ''
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
