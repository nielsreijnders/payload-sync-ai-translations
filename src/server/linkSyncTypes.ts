export type LinkSyncLocaleReport = {
  errors: string[]
  locale: string
  missingAlternates: string[]
  replacements: number
  updated: boolean
  warnings: string[]
}

export type LinkSyncResult = {
  collection: string
  documentId: string | number
  errors: string[]
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
}

export type BulkLinkSyncDocumentReport = LinkSyncResult & {
  label: string
}

export type BulkLinkSyncSummary = {
  documentsProcessed: number
  documentsUpdated: number
  errors: string[]
  missingAlternates: Array<{ locale: string; count: number }>
  replacements: number
  updatedLocales: number
  warnings: string[]
}

export type BulkLinkSyncResponse = {
  details: BulkLinkSyncDocumentReport[]
  summary: BulkLinkSyncSummary
}
