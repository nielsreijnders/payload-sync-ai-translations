import type { Payload } from 'payload'

import type {
  TranslateReviewLocale,
  TranslateReviewRequestPayload,
  TranslateReviewSuggestion,
} from './types.js'

import {
  extractPlainText,
  getValueAtPath,
  MAX_CHARS_PER_CHUNK,
} from '../utils/localizedFields.js'
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

export async function generateTranslationReview(
  payload: Payload,
  parsed: TranslateReviewRequestPayload,
): Promise<TranslateReviewLocale[]> {
  const locales: TranslateReviewLocale[] = []

  for (const localeCode of parsed.locales) {
    let localeDoc: null | Record<string, unknown> = null

    try {
      const result = await payload.findByID({
        id: parsed.id,
        collection: parsed.collection,
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
    const mismatches: TranslateReviewLocale['mismatches'] = []
    const aiInputs: MissingInformationCheckInput[] = []
    const existingByIndex = new Map<number, string>()
    let existingCount = 0

    const translateCandidates: TranslateSuggestionInput[] = []

    parsed.items.forEach((item, index) => {
      const existingValue = localeDoc ? getValueAtPath(localeDoc, item.path) : undefined
      const existingText = extractPlainText(existingValue) ?? ''

      if (!existingText) {
        translateIndexes.add(index)
        translateCandidates.push({ index, text: item.text })
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
        const results = await openAiDetectMissingInformation(aiInputs, parsed.from, localeCode)
        for (const result of results) {
          if (!result.missing) {
            continue
          }

          translateIndexes.add(result.index)

          const sourceItem = parsed.items[result.index]
          mismatches.push({
            defaultText: sourceItem?.text ?? '',
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
            parsed.from,
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

  return locales
}
