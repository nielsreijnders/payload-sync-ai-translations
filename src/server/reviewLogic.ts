import type { Payload } from 'payload'

import type {
  TranslateReviewLocale,
  TranslateReviewMismatch,
  TranslateReviewRequestPayload,
  TranslateReviewResponse,
  TranslateReviewSuggestion,
} from './types.js'

import { extractPlainText, getValueAtPath, MAX_CHARS_PER_CHUNK } from '../utils/localizedFields.js'
import { type MissingInformationCheckInput, openAiDetectMissingInformation, openAiTranslateTexts } from './openai.js'

type TranslateSuggestionInput = { index: number; text: string }

type PendingLocaleContext = {
  aiInputs: MissingInformationCheckInput[]
  existingByIndex: Map<number, string>
  existingCount: number
  mismatches: TranslateReviewMismatch[]
  suggestions: TranslateReviewSuggestion[]
  translateIndexes: Set<number>
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

export async function runTranslationReview(
  payload: Payload,
  request: TranslateReviewRequestPayload,
): Promise<TranslateReviewResponse> {
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

    const context: PendingLocaleContext = {
      aiInputs: [],
      existingByIndex: new Map<number, string>(),
      existingCount: 0,
      mismatches: [],
      suggestions: [],
      translateIndexes: new Set<number>(),
    }

    const translateCandidates: TranslateSuggestionInput[] = []

    request.items.forEach((item, index) => {
      const existingValue = localeDoc ? getValueAtPath(localeDoc, item.path) : undefined
      const existingText = extractPlainText(existingValue) ?? ''

      if (!existingText) {
        context.translateIndexes.add(index)
        translateCandidates.push({ index, text: item.text })
        return
      }

      context.existingCount += 1
      context.existingByIndex.set(index, existingText)
      context.aiInputs.push({
        defaultText: item.text,
        index,
        translatedText: existingText,
      })
    })

    if (context.aiInputs.length) {
      const results = await openAiDetectMissingInformation(
        context.aiInputs,
        request.from,
        localeCode,
      )

      for (const result of results) {
        if (!result.missing) {
          continue
        }

        context.translateIndexes.add(result.index)

        const sourceItem = request.items[result.index]
        context.mismatches.push({
          defaultText: sourceItem?.text ?? '',
          existingText: context.existingByIndex.get(result.index) ?? '',
          index: result.index,
          path: sourceItem?.path ?? '',
          reason: result.reason || 'Missing information detected.',
        })
        if (sourceItem) {
          translateCandidates.push({ index: result.index, text: sourceItem.text })
        }
      }
    }

    const sortedIndexes = Array.from(context.translateIndexes).sort((a, b) => a - b)

    const translateSuggestions: TranslateReviewSuggestion[] = []
    if (translateCandidates.length) {
      const suggestionChunks = chunkSuggestionInputs(translateCandidates)
      for (const chunk of suggestionChunks) {
        const translations = await openAiTranslateTexts(
          chunk.map((entry) => entry.text),
          request.from,
          localeCode,
        )

        if (translations.length !== chunk.length) {
          throw new Error(
            `Translator mismatch: expected ${chunk.length}, received ${translations.length}`,
          )
        }

        for (let index = 0; index < chunk.length; index += 1) {
          const input = chunk[index]
          translateSuggestions.push({ index: input.index, text: translations[index] })
        }
      }
    }

    const sanitizeSuggestions = (suggestions: TranslateReviewSuggestion[]) => {
      const seen = new Set<number>()
      return suggestions.filter((suggestion) => {
        if (!Number.isInteger(suggestion.index)) {
          return false
        }
        if (suggestion.text.trim().length === 0) {
          return false
        }
        if (seen.has(suggestion.index)) {
          return false
        }
        seen.add(suggestion.index)
        return true
      })
    }

    locales.push({
      code: localeCode,
      existingCount: context.existingCount,
      mismatches: context.mismatches,
      suggestions: sanitizeSuggestions(translateSuggestions),
      translateIndexes: sortedIndexes,
    })
  }

  return { locales }
}
