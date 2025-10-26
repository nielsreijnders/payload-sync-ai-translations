import type { Payload } from 'payload'

import type {
  TranslateChunk,
  TranslateLocaleRequestPayload,
  TranslateRequestPayload,
  TranslateStreamEvent,
} from './types.js'

import { toLexical } from '../utils/lexical.js'
import { getValueAtPath, isLexicalValue } from '../utils/localizedFields.js'
import { createLexicalTranslationPlan, htmlToLexicalValue } from './lexical.js'
import { openAiTranslateTexts } from './openai.js'

function cloneLocaleData<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value)
  }

  return JSON.parse(JSON.stringify(value)) as T
}

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

// setValueAtPath but preserves blockType when creating new block entries by referencing original doc structure
function setValueAtPath(original: unknown, source: unknown, path: string, value: unknown): unknown {
  const segments = path.split('.')

  const apply = (origBranch: unknown, current: unknown, index: number): unknown => {
    if (index >= segments.length) {
      return value
    }

    const segment = segments[index]
    const isIndex = /^\d+$/.test(segment)

    if (isIndex) {
      const position = Number(segment)
      const origArray = Array.isArray(origBranch) ? origBranch : undefined
      const targetArray = Array.isArray(current) ? [...current] : []
      const nextOrig = origArray && origArray.length > position ? origArray[position] : undefined
      const existing = targetArray[position]
      const applied = apply(nextOrig, existing, index + 1)

      // If we created a new block object and original has a blockType, carry it over.
      if (
        applied &&
        typeof applied === 'object' &&
        !Array.isArray(applied) &&
        nextOrig &&
        typeof nextOrig === 'object' &&
        (nextOrig as { blockType?: unknown }).blockType &&
        !(applied as { blockType?: unknown }).blockType
      ) {
        ;(applied as Record<string, unknown>).blockType = (
          nextOrig as {
            blockType?: unknown
          }
        ).blockType as string
      }

      targetArray[position] = applied
      return targetArray
    }

    const origRecord =
      typeof origBranch === 'object' && origBranch !== null && !Array.isArray(origBranch)
        ? (origBranch as Record<string, unknown>)
        : undefined
    const targetRecord =
      typeof current === 'object' && current !== null && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>) }
        : {}
    const nextOrig = origRecord ? origRecord[segment] : undefined
    targetRecord[segment] = apply(nextOrig, targetRecord[segment], index + 1)
    return targetRecord
  }

  return apply(original, source, 0)
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
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load base document.'
    yield { type: 'error', message }
    return
  }

  for (const localeEntry of locales) {
    const { chunks, code: locale } = localeEntry
    let existingLocaleDoc: null | Record<string, unknown> = null

    try {
      const localeDoc = await payload.findByID({ id, collection, depth: 0, locale })
      if (localeDoc && typeof localeDoc === 'object') {
        existingLocaleDoc = localeDoc as Record<string, unknown>
      }
    } catch (_error) {
      existingLocaleDoc = null
    }
    const overrideItems = Array.isArray(localeEntry.overrides) ? localeEntry.overrides : []
    const localeTotalItems = countItems(chunks) + overrideItems.length

    if (!localeTotalItems) {
      continue
    }

    let localeData: unknown = existingLocaleDoc ? cloneLocaleData(existingLocaleDoc) : {}

    if (typeof localeData !== 'object' || localeData === null || Array.isArray(localeData)) {
      localeData = {}
    }

    delete (localeData as Record<string, unknown>).id
    delete (localeData as Record<string, unknown>)._id
    delete (localeData as Record<string, unknown>).createdAt
    delete (localeData as Record<string, unknown>).updatedAt

    let completed = 0

    for (const chunk of chunks) {
      const plans = chunk.map((item) => {
        if (!item.lexical) {
          return {
            apply(translated: string[]) {
              return translated[0] ?? item.text
            },
            segments: [item.text],
          }
        }

        const originalValue = baseDoc ? getValueAtPath(baseDoc, item.path) : undefined
        if (isLexicalValue(originalValue)) {
          return createLexicalTranslationPlan(originalValue, item.text)
        }

        return {
          apply(translated: string[]) {
            const next = translated[0] ?? item.text
            return toLexical(next)
          },
          segments: [item.text],
        }
      })

      const texts = plans.flatMap((plan) => plan.segments)

      let translated: string[]
      try {
        translated = await openAiTranslateTexts(texts, from, locale)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to translate chunk'
        payload.logger?.error?.(
          `[AI Translate] OpenAI translation failed for ${collection}#${id} (${locale}): ${message}`,
        )
        yield { type: 'error', message }
        return
      }

      if (translated.length !== texts.length) {
        yield {
          type: 'error',
          message: `Translator mismatch: expected ${texts.length}, received ${translated.length}`,
        }
        payload.logger?.error?.(
          `[AI Translate] Translation mismatch for ${collection}#${id} (${locale}).`,
        )
        return
      }

      let cursor = 0
      for (let index = 0; index < chunk.length; index += 1) {
        const item = chunk[index]
        const plan = plans[index]
        const segmentCount = plan.segments.length
        const slice = translated.slice(cursor, cursor + segmentCount)
        cursor += segmentCount
        const nextValue = plan.apply(slice)

        if (item.lexical && !isLexicalValue(nextValue)) {
          const fallbackText = slice.length ? slice.join(' ').trim() : ''
          localeData = setValueAtPath(
            baseDoc,
            localeData,
            item.path,
            toLexical(fallbackText || item.text),
          )
          continue
        }

        localeData = setValueAtPath(baseDoc, localeData, item.path, nextValue)
      }

      if (cursor !== translated.length) {
        payload.logger?.warn?.(
          `[AI Translate] Translation cursor mismatch for ${collection}#${id} (${locale}).`,
        )
      }

      completed += chunk.length
      yield { type: 'progress', completed, locale, total: localeTotalItems }
    }

    if (overrideItems.length) {
      for (const override of overrideItems) {
        const nextValue = override.lexical
          ? await htmlToLexicalValue(payload, override.text)
          : override.text
        localeData = setValueAtPath(baseDoc, localeData, override.path, nextValue)
        completed += 1
        yield { type: 'progress', completed, locale, total: localeTotalItems }
      }
    }

    if (typeof localeData !== 'object' || localeData === null || Array.isArray(localeData)) {
      yield { type: 'error', message: 'Translated data has unexpected shape.' }
      return
    }

    try {
      await payload.update({
        id,
        collection,
        data: localeData as Record<string, unknown>,
        locale,
        overrideAccess: true,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to update locale ${locale}`
      payload.logger?.error?.(
        `[AI Translate] Failed to save ${collection}#${id} (${locale}): ${message}`,
      )
      yield { type: 'error', message }
      return
    }

    payload.logger?.info?.(
      `[AI Translate] Saved translations for ${collection}#${id} (${locale}).`,
    )
    yield { type: 'applied', locale }
  }

  payload.logger?.info?.(`[AI Translate] Completed translation for ${collection}#${id}.`)
  yield { type: 'done' }
}
