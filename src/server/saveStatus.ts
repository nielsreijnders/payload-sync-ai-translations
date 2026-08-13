/**
 * Version flags for plugin saves that mirror the source document's publish
 * state instead of Payload's default publish-all behaviour:
 *
 * - published source → publish only the saved locale (`publishSpecificLocale`),
 *   leaving draft edits in other locales untouched;
 * - never-published (draft) source → save the locale as a draft so the
 *   document is not published as a side effect;
 * - no drafts configured (no `_status` on the document) → save without
 *   version flags, matching the previous behaviour.
 */
export type SaveStatusFlags = {
  data?: { _status: 'published' }
  draft?: true
  publishSpecificLocale?: string
}

export function resolveSaveStatusFlags(sourceStatus: unknown, locale: string): SaveStatusFlags {
  if (sourceStatus === 'published') {
    return { data: { _status: 'published' }, publishSpecificLocale: locale }
  }

  if (sourceStatus === 'draft') {
    return { draft: true }
  }

  return {}
}

export function readDocumentStatus(doc: unknown): unknown {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return undefined
  }

  return (doc as { _status?: unknown })._status
}
