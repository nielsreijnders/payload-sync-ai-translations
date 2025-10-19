import type {
  TranslateReviewLocale,
  TranslateReviewRequestPayload,
  TranslateReviewResponse,
  TranslateReviewSuggestion,
} from '../../../server/types.js'
import type { TranslatableItem } from './buildTranslatableItems.js'

export type ReviewRequest = {
  collection: string
  defaultLocale: string
  id: string
  items: TranslatableItem[]
  locales: string[]
}

export type ReviewResponse = TranslateReviewResponse

function isValidSuggestion(value: unknown): value is TranslateReviewSuggestion {
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isInteger((value as { index?: unknown }).index) &&
    typeof (value as { text?: unknown }).text === 'string'
  )
}

function sanitizeLocale(locale: unknown): null | TranslateReviewLocale {
  if (typeof locale !== 'object' || locale === null) {
    return null
  }

  const candidate = locale as Record<string, unknown>
  const code = candidate.code
  const translateIndexes = candidate.translateIndexes

  if (typeof code !== 'string' || !Array.isArray(translateIndexes)) {
    return null
  }

  const existingRaw = candidate.existingCount
  const existingCount =
    typeof existingRaw === 'number' && Number.isFinite(existingRaw) ? existingRaw : 0

  const mismatches = Array.isArray(candidate.mismatches)
    ? (candidate.mismatches as TranslateReviewLocale['mismatches'])
    : []

  const suggestions = Array.isArray(candidate.suggestions)
    ? (candidate.suggestions as unknown[]).filter(isValidSuggestion)
    : undefined

  return {
    code,
    existingCount,
    mismatches,
    suggestions,
    translateIndexes: (translateIndexes as unknown[]).filter((value): value is number =>
      Number.isInteger(value),
    ),
  }
}

export async function requestTranslationReview(request: ReviewRequest): Promise<ReviewResponse> {
  const response = await fetch('/api/ai-translate/review', {
    body: JSON.stringify({
      id: request.id,
      collection: request.collection,
      from: request.defaultLocale,
      items: request.items,
      locales: request.locales,
    } satisfies TranslateReviewRequestPayload),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    const message = await response.text().catch(() => 'Vertaalcontrole mislukt.')
    throw new Error(message || 'Vertaalcontrole mislukt.')
  }

  const body = (await response.json()) as TranslateReviewResponse
  if (!body || !Array.isArray(body.locales)) {
    throw new Error('Onverwachte reactie van de vertaalcontrole.')
  }

  const locales = body.locales
    .map(sanitizeLocale)
    .filter((locale): locale is TranslateReviewLocale => Boolean(locale))

  return { locales }
}

