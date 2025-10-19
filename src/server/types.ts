export type TranslateItem = {
  lexical: boolean
  path: string
  text: string
}

export type TranslateChunk = TranslateItem[]

export type TranslateOverride = TranslateItem

export type TranslateLocaleRequestPayload = {
  chunks: TranslateChunk[]
  code: string
  overrides?: TranslateOverride[]
}

export type TranslateRequestPayload = {
  collection: string
  from: string
  id: number | string
  locales: TranslateLocaleRequestPayload[]
}

export type TranslateReviewRequestPayload = {
  collection: string
  from: string
  id: number | string
  items: TranslateItem[]
  locales: string[]
}

export type TranslateReviewMismatch = {
  defaultText: string
  existingText: string
  index: number
  path: string
  reason: string
}

export type TranslateReviewSuggestion = {
  index: number
  text: string
}

export type TranslateReviewLocale = {
  code: string
  existingCount: number
  mismatches: TranslateReviewMismatch[]
  suggestions?: TranslateReviewSuggestion[]
  translateIndexes: number[]
}

export type TranslateReviewResponse = {
  locales: TranslateReviewLocale[]
}

export type TranslateProgressEvent = {
  completed: number
  locale: string
  total: number
  type: 'progress'
}

export type TranslateAppliedEvent = {
  locale: string
  type: 'applied'
}

export type TranslateDoneEvent = { type: 'done' }

export type TranslateErrorEvent = {
  message: string
  type: 'error'
}

export type TranslateStreamEvent =
  | TranslateAppliedEvent
  | TranslateDoneEvent
  | TranslateErrorEvent
  | TranslateProgressEvent
