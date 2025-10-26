import type { PayloadHandler } from 'payload'

import type {
  TranslateReviewLocale,
  TranslateReviewRequestPayload,
} from './types.js'

import { generateTranslationReview } from './reviewPlan.js'

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

export function createAiTranslateReviewHandler(): PayloadHandler {
  return async (req) => {
    try {
      const payload = req.payload
      if (!payload) {
        throw new Error('Payload instance is not available on the request')
      }

      // @ts-ignore oopsie for now
      const parsed = parseBody(await req.json())
      let locales: TranslateReviewLocale[] = []

      try {
        locales = await generateTranslationReview(payload, parsed)
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Validation of existing translations failed.'
        return Response.json({ message }, { status: 500 })
      }

      return Response.json({ locales })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request body'
      return Response.json({ message }, { status: 400 })
    }
  }
}
