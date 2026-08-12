import type { Payload, PayloadHandler } from 'payload'

import type {
  TranslateReviewLocale,
  TranslateReviewMismatch,
  TranslateReviewRequestPayload,
  TranslateReviewResponse,
  TranslateReviewSuggestion,
} from './translationTypes.js'

import { stripLexicalMarkers } from '../utils/lexical.js'
import { extractPlainText, getValueAtPath } from '../utils/localizedFields.js'
import { resolveFeatureModels } from './aiSettingsGlobal.js'
import { resolveCustomPrompt } from './customPrompt.js'
import { logDebug } from './debugSettings.js'
import { loadLocalizedDocument, stripDocumentMetadata } from './documentUtils.js'
import { getMaxCharsPerRequest } from './openAiSettings.js'
import {
  type MissingInformationCheckInput,
  openAiDetectMissingInformation,
  openAiTranslateTexts,
  shouldPreserveOriginalValue,
} from './openAiTranslationClient.js'
import { rejectUnauthenticated } from './requireUser.js'
import { buildSyncSnapshot, buildTargetKey, recordSyncSnapshot } from './syncStatusStore.js'
import { getStoredTarget } from './translationStateStore.js'

type TranslateSuggestionInput = {
  index: number
  text: string
}

function chunkSuggestionInputs(entries: TranslateSuggestionInput[]): TranslateSuggestionInput[][] {
  const maxCharsPerRequest = getMaxCharsPerRequest()
  const chunks: TranslateSuggestionInput[][] = []
  let current: TranslateSuggestionInput[] = []
  let total = 0

  for (const entry of entries) {
    const length = entry.text.length
    if (current.length && total + length > maxCharsPerRequest) {
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

function normalizeTextForComparison(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * Removes review entries whose AI suggestion is identical to the existing
 * translation. Applying such a suggestion would be a no-op, so the same
 * "missing information" flag would resurface on every sync — an endless
 * review loop for the editor.
 */
export function dropNoopReviewEntries(input: {
  mismatches: TranslateReviewMismatch[]
  suggestions: TranslateReviewSuggestion[]
  translateIndexes: number[]
}): {
  mismatches: TranslateReviewMismatch[]
  suggestions: TranslateReviewSuggestion[]
  translateIndexes: number[]
} {
  const suggestionByIndex = new Map(
    input.suggestions.map((suggestion) => [suggestion.index, suggestion.text]),
  )
  const noopIndexes = new Set<number>()

  for (const mismatch of input.mismatches) {
    const suggested = suggestionByIndex.get(mismatch.index)
    if (typeof suggested !== 'string') {
      continue
    }

    const normalizedSuggested = normalizeTextForComparison(stripLexicalMarkers(suggested))
    const normalizedExisting = normalizeTextForComparison(stripLexicalMarkers(mismatch.existingText))

    if (normalizedSuggested && normalizedSuggested === normalizedExisting) {
      noopIndexes.add(mismatch.index)
    }
  }

  if (!noopIndexes.size) {
    return input
  }

  return {
    mismatches: input.mismatches.filter((mismatch) => !noopIndexes.has(mismatch.index)),
    suggestions: input.suggestions.filter((suggestion) => !noopIndexes.has(suggestion.index)),
    translateIndexes: input.translateIndexes.filter((index) => !noopIndexes.has(index)),
  }
}

function isSameLocale(source: string, target: string): boolean {
  return (
    source.trim().toLowerCase().replace(/_/g, '-') ===
    target.trim().toLowerCase().replace(/_/g, '-')
  )
}

function shouldTreatAsUntranslated(
  sourceText: string,
  existingText: string,
  from: string,
  to: string,
): boolean {
  if (isSameLocale(from, to)) {
    return false
  }

  const normalizedSource = normalizeTextForComparison(sourceText)
  const normalizedExisting = normalizeTextForComparison(existingText)

  if (!normalizedSource || normalizedSource !== normalizedExisting) {
    return false
  }

  return !shouldPreserveOriginalValue(normalizedSource)
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
    ? { id: identifier, collection: collection.trim() }
    : { global: (global as string).trim() }

  // @ts-expect-error -- Need to investigate
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

  logDebug(payload, '[AI Translate] Generating translation review.', {
    // @ts-expect-error -- Need to investigate
    collection: request.collection,
    documentId: request.id,
    from: request.from,
    // @ts-expect-error -- Need to investigate
    global: request.global,
    itemCount: request.items.length,
    localeCount: request.locales.length,
  })

  let baseDoc: null | Record<string, unknown> = null

  try {
    const doc = await loadLocalizedDocument(
      payload,
      isCollectionTarget
        ? {
            id: request.id,
            collection: request.collection,
            fallbackLocale: false,
            locale: request.from,
          }
        : {
            fallbackLocale: false,
            // @ts-expect-error -- Need to investigate
            global: request.global as string,
            locale: request.from,
          },
    )

    if (doc && typeof doc === 'object') {
      baseDoc = doc
      stripDocumentMetadata(baseDoc)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load base document.'
    throw new Error(message)
  }

  logDebug(payload, '[AI Translate] Loaded base document for review.', {
    // @ts-expect-error -- Need to investigate
    collection: request.collection,
    documentId: request.id,
    from: request.from,
    // @ts-expect-error -- Need to investigate
    global: request.global,
    hasBaseDoc: Boolean(baseDoc),
  })

  // @ts-expect-error -- Need to investigate
  const storedEntry = getStoredTarget({ collection: request.collection, global: request.global })
  const customPromptFn = storedEntry?.customPrompt
  const promptCache = new Map<string, string | undefined>()
  const featureModels = await resolveFeatureModels(payload)

  for (const localeCode of request.locales) {
    let localeDoc: null | Record<string, unknown> = null

    try {
      const result = await loadLocalizedDocument(
        payload,
        isCollectionTarget
          ? {
              id: request.id,
              collection: request.collection,
              fallbackLocale: false,
              locale: localeCode,
            }
          : {
              fallbackLocale: false,
              // @ts-expect-error -- Need to investigate
              global: request.global as string,
              locale: localeCode,
            },
      )

      if (result && typeof result === 'object') {
        localeDoc = result
        stripDocumentMetadata(localeDoc)
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Failed to load locale data for ${localeCode}.`
      throw new Error(message)
    }

    logDebug(payload, '[AI Translate] Loaded locale document for review.', {
      // @ts-expect-error -- Need to investigate
      collection: request.collection,
      documentId: request.id,
      // @ts-expect-error -- Need to investigate
      global: request.global,
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

      if (shouldTreatAsUntranslated(defaultText, existingText, request.from, localeCode)) {
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
            // @ts-expect-error -- Need to investigate
            collection: request.collection,
            documentId: request.id,
            inputCount: aiInputs.length,
            locale: localeCode,
          },
        )
        const results = await openAiDetectMissingInformation(aiInputs, request.from, localeCode, {
          model: featureModels.review,
        })
        logDebug(payload, '[AI Translate] Missing information check results.', {
          // @ts-expect-error -- Need to investigate
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
          // @ts-expect-error -- Need to investigate
          collection: request.collection,
          documentId: request.id,
          locale: localeCode,
          totalSuggestions: orderedCandidates.length,
        })

        if (!promptCache.has(localeCode)) {
          const promptData = baseDoc ?? localeDoc ?? {}
          const prompt = resolveCustomPrompt(payload, customPromptFn, promptData, {
            // @ts-expect-error -- Need to investigate
            collection: request.collection,
            // @ts-expect-error -- Need to investigate
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
            { customPrompt: localePrompt, model: featureModels.translate },
          )

          chunk.forEach((item, chunkIndex) => {
            const text = translated[chunkIndex] ?? ''
            collected.push({ index: item.index, text })
          })
        }

        suggestions = collected
        logDebug(payload, '[AI Translate] Generated AI suggestions for review.', {
          // @ts-expect-error -- Need to investigate
          collection: request.collection,
          documentId: request.id,
          locale: localeCode,
          suggestionCount: suggestions.length,
        })
      } catch (_error) {
        suggestions = []
      }
    }

    const cleaned = dropNoopReviewEntries({
      mismatches,
      suggestions,
      translateIndexes: sortedIndexes,
    })

    if (cleaned.mismatches.length < mismatches.length) {
      logDebug(payload, '[AI Translate] Dropped no-op review entries.', {
        dropped: mismatches.length - cleaned.mismatches.length,
        locale: localeCode,
      })
    }

    // The review confirmed this locale fully covers the current content;
    // refresh the sync snapshot so the out-of-sync indicator and the
    // Translation Status overview stop flagging the document.
    if (!cleaned.translateIndexes.length && !cleaned.mismatches.length && request.items.length) {
      await recordSyncSnapshot(payload, {
        locale: localeCode,
        snapshot: buildSyncSnapshot(request.items),
        target: buildTargetKey({
          collection: 'collection' in request ? request.collection : undefined,
          documentId: 'id' in request ? request.id : undefined,
          global: 'global' in request ? request.global : undefined,
        }),
      })
    }

    locales.push({
      code: localeCode,
      existingCount,
      mismatches: cleaned.mismatches,
      suggestions: cleaned.suggestions.length ? cleaned.suggestions : undefined,
      translateIndexes: cleaned.translateIndexes,
    })
  }

  return { locales }
}

export function createAiTranslateReviewHandler(): PayloadHandler {
  return async (req) => {
    const unauthorized = rejectUnauthenticated(req)
    if (unauthorized) {
      return unauthorized
    }

    try {
      const payload = req.payload
      if (!payload) {
        throw new Error('Payload instance is not available on the request')
      }

      // @ts-expect-error -- Need to investigate
      const parsed = parseBody(await req.json())

      logDebug(payload, '[AI Translate] Parsed translation review request.', {
        // @ts-expect-error -- Need to investigate
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
