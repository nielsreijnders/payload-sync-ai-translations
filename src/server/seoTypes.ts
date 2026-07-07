export type SeoScoreStatus = 'good' | 'needs-work' | 'poor'

export type SeoScanDocument = {
  collection: string
  description: string
  headingCount: number
  id: number | string
  issues: string[]
  label: string
  locale: string
  score: number
  slug?: string
  status: SeoScoreStatus
  title: string
  updatedAt?: string
  wordCount: number
}

export type SeoScanRequest = {
  collections: string[]
  locale: string
}

export type SeoScanEvent =
  | {
      collection: string
      label: string
      totalDocuments: number
      type: 'collection-start'
    }
  | {
      collection: string
      message: string
      type: 'collection-error'
    }
  | {
      document: SeoScanDocument
      type: 'document-result'
    }
  | {
      failed: number
      processed: number
      type: 'scan-complete'
    }
  | {
      message: string
      type: 'error'
    }
  | {
      totalCollections: number
      totalDocuments: number
      type: 'scan-start'
    }

export type SeoUpdateRequest = {
  collection: string
  description: string
  id: number | string
  locale: string
  title: string
}
