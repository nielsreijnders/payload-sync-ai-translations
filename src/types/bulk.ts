export type BulkStartEvent = {
  totalCollections: number
  totalDocuments: number
  type: 'start'
}

export type BulkCollectionStartEvent = {
  collection: string
  label: string
  totalDocuments: number
  type: 'collection-start'
}

export type BulkCollectionCompleteEvent = {
  collection: string
  failed: number
  label: string
  processed: number
  skipped: number
  type: 'collection-complete'
}

export type BulkDocumentStartEvent = {
  collection: string
  id: string
  label: string
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

export type BulkDocumentSkippedEvent = {
  collection: string
  id: string
  reason: string
  type: 'document-skipped'
}

export type BulkOverallProgressEvent = {
  processed: number
  total: number
  type: 'overall-progress'
}

export type BulkLogEvent = {
  level: 'error' | 'info'
  message: string
  type: 'log'
}

export type BulkDoneEvent = {
  failed: number
  processed: number
  skipped: number
  type: 'done'
}

export type BulkStreamEvent =
  | BulkCollectionCompleteEvent
  | BulkCollectionStartEvent
  | BulkDocumentErrorEvent
  | BulkDocumentProgressEvent
  | BulkDocumentSkippedEvent
  | BulkDocumentStartEvent
  | BulkDocumentSuccessEvent
  | BulkDoneEvent
  | BulkLogEvent
  | BulkOverallProgressEvent
  | BulkStartEvent
