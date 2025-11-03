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

export type BulkTranslateRequestPayload = {
  collections: string[]
}

export type BulkStartEvent = {
  totalCollections: number
  totalDocuments: number
  type: 'bulk-start'
}

export type BulkCollectionStartEvent = {
  collection: string
  label: string
  totalDocuments: number
  type: 'collection-start'
}

export type BulkDocumentStartEvent = {
  collection: string
  id: string
  type: 'document-start'
}

export type BulkDocumentProgressEvent = {
  collection: string
  completed: number
  id: string
  locale: string
  total: number
  type: 'document-progress'
}

export type BulkDocumentAppliedEvent = {
  collection: string
  id: string
  locale: string
  type: 'document-applied'
}

export type BulkDocumentSkippedEvent = {
  collection: string
  id: string
  reason: string
  type: 'document-skipped'
}

export type BulkDocumentSuccessEvent = {
  collection: string
  id: string
  type: 'document-success'
}

export type BulkDocumentErrorEvent = {
  collection: string
  id: string
  message: string
  type: 'document-error'
}

export type BulkCollectionCompleteEvent = {
  collection: string
  failed: number
  processed: number
  skipped: number
  type: 'collection-complete'
}

export type BulkCompleteEvent = {
  failed: number
  processed: number
  skipped: number
  type: 'bulk-complete'
}

export type BulkGenericErrorEvent = {
  message: string
  type: 'error'
}

export type BulkStreamEvent =
  | BulkCollectionCompleteEvent
  | BulkCollectionStartEvent
  | BulkCompleteEvent
  | BulkDocumentAppliedEvent
  | BulkDocumentErrorEvent
  | BulkDocumentProgressEvent
  | BulkDocumentSkippedEvent
  | BulkDocumentStartEvent
  | BulkDocumentSuccessEvent
  | BulkGenericErrorEvent
  | BulkStartEvent

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
