import type { Payload, PayloadHandler } from 'payload'

import type {
  TranslateReviewLocale,
  TranslateReviewMismatch,
  TranslateReviewRequestPayload,
  TranslateReviewResponse,
  TranslateReviewSuggestion,
} from './types.js'

import { extractPlainText, getValueAtPath, isLexicalValue, MAX_CHARS_PER_CHUNK } from '../utils/localizedFields.js'
import { createLexicalTranslationPlan, lexicalValueToHTML } from './lexical.js'
import {
  type MissingInformationCheckInput,
  openAiDetectMissingInformation,
  openAiTranslateTexts,
} from './openai.js'

type TranslateSuggestionPlan = {
  apply(translated: string[]): Promise<string> | string
  index: number
  segments: string[]
  totalLength: number
}

function chunkSuggestionPlans(entries: TranslateSuggestionPlan[]): TranslateSuggestionPlan[][] {
  const chunks: TranslateSuggestionPlan[][] = []
  let current: TranslateSuggestionPlan[] = []
  let total = 0

  for (const entry of entries) {
    const length = entry.totalLength || entry.segments.reduce((sum, segment) => sum + segment.length, 0)
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

  const lexicalSuggestionDataByIndex = new Map<
    number,
    { defaultHTML: string; plan: ReturnType<typeof createLexicalTranslationPlan> }
  >()

  if (baseDoc) {
    for (let index = 0; index < request.items.length; index += 1) {
      const item = request.items[index]
      if (!item?.lexical) {
        continue
      }

      const value = getValueAtPath(baseDoc, item.path)
      if (!isLexicalValue(value)) {
        continue
      }

      const plan = createLexicalTranslationPlan(value, item.text)
      const html = await lexicalValueToHTML(value)
      lexicalSuggestionDataByIndex.set(index, {
        defaultHTML: html ?? '',
        plan,
      })
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

    const suggestionPlans = new Map<number, TranslateSuggestionPlan>()

    const ensureSuggestionPlan = (index: number, fallbackText: string) => {
      if (suggestionPlans.has(index)) {
        return
      }

      const item = request.items[index]
      if (!item) {
        return
      }

      if (item.lexical) {
        const lexicalEntry = lexicalSuggestionDataByIndex.get(index)
        if (lexicalEntry) {
          const { defaultHTML, plan } = lexicalEntry
          suggestionPlans.set(index, {
            apply: async (translated) => {
              const lexicalValue = plan.apply(translated)
              if (isLexicalValue(lexicalValue)) {
                const html = await lexicalValueToHTML(lexicalValue)
                if (html) {
                  return html
                }
              }
              const joined = translated.length ? translated.join(' ').trim() : ''
              if (joined) {
                return joined
              }
              return defaultHTML || fallbackText
            },
            index,
            segments: plan.segments,
            totalLength: plan.segments.reduce((sum, segment) => sum + segment.length, 0),
          })
          return
        }

        suggestionPlans.set(index, {
          apply: (translated) => {
            const joined = translated.length ? translated.join(' ').trim() : ''
            return joined || fallbackText
          },
          index,
          segments: [fallbackText],
          totalLength: fallbackText.length,
        })
        return
      }

      suggestionPlans.set(index, {
        apply: (translated) => translated[0] ?? fallbackText,
        index,
        segments: [fallbackText],
        totalLength: fallbackText.length,
      })
    }

    request.items.forEach((item, index) => {
      const existingValue = localeDoc ? getValueAtPath(localeDoc, item.path) : undefined
      const existingText = extractPlainText(existingValue) ?? ''

      if (!existingText) {
        translateIndexes.add(index)
        const fallbackText = item.lexical
          ? lexicalSuggestionDataByIndex.get(index)?.defaultHTML ?? item.text
          : item.text
        ensureSuggestionPlan(index, fallbackText)
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
            const fallbackText = sourceItem.lexical
              ? lexicalSuggestionDataByIndex.get(result.index)?.defaultHTML ?? sourceItem.text
              : sourceItem.text
            ensureSuggestionPlan(result.index, fallbackText)
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

    if (suggestionPlans.size) {
      try {
        const orderedPlans = sortedIndexes
          .map((index) => suggestionPlans.get(index) ?? null)
          .filter((plan): plan is TranslateSuggestionPlan => Boolean(plan))

        if (orderedPlans.length) {
          const chunks = chunkSuggestionPlans(orderedPlans)
          const collected: TranslateReviewSuggestion[] = []

          for (const chunk of chunks) {
            const inputs = chunk.flatMap((plan) => plan.segments)
            if (!inputs.length) {
              continue
            }

            const translated = await openAiTranslateTexts(inputs, request.from, localeCode)

            let cursor = 0
            for (const plan of chunk) {
              const count = plan.segments.length
              const slice = translated.slice(cursor, cursor + count)
              cursor += count
              const text = await plan.apply(slice)
              collected.push({ index: plan.index, text })
            }
          }

          suggestions = collected
        }
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
