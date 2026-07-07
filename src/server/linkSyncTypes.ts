export type LinkSyncLocaleReport = {
  errors: string[]
  locale: string
  missingAlternates: string[]
  replacements: number
  updated: boolean
  warnings: string[]
}

export type LinkSyncResult = {
  collection?: string
  documentId?: number | string
  errors: string[]
  global?: string
  missingAlternateLocales: string[]
  processedLocales: string[]
  processedUrls: number
  replacements: number
  reports: LinkSyncLocaleReport[]
  unchangedLocales: string[]
  updatedLocales: string[]
  warnings: string[]
}

export type BulkLinkSyncRequestPayload = {
  collections: string[]
  /**
   * Optional per-collection document filter. When present for a collection,
   * only these documents are link-synced instead of the whole collection.
   */
  documents?: Record<string, Array<number | string>>
}

export type BulkLinkSyncDocumentReport = {
  label: string
} & LinkSyncResult

export type BulkLinkSyncSummary = {
  documentsProcessed: number
  documentsUpdated: number
  errors: string[]
  missingAlternates: Array<{ count: number; locale: string }>
  replacements: number
  updatedLocales: number
  warnings: string[]
}

export type BulkLinkSyncResponse = {
  details: BulkLinkSyncDocumentReport[]
  summary: BulkLinkSyncSummary
}
