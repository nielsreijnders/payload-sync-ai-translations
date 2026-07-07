import type { SeoScanDocument, SeoUpdateRequest } from '../../../server/seoTypes.js'

export async function updateSeoMetadata(input: SeoUpdateRequest): Promise<SeoScanDocument> {
  const response = await fetch('/api/ai-seo/update', {
    body: JSON.stringify(input),
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  const body = await response.json().catch(() => null)

  if (!response.ok || !body?.document) {
    throw new Error(body?.message || 'Failed to update SEO metadata.')
  }

  return body.document as SeoScanDocument
}
