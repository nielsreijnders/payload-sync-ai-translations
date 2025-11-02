import { toast } from '@payloadcms/ui'

import type { LocaleTranslationSelection, PendingReview } from '../types'

import { performTranslations } from '../utils/performTranslations.js'
import { buildTranslationRequest } from './buildTranslationRequest.js'

/**
 * runTranslations
 * ------------------------------------
 * Executes the translation flow with user feedback:
 * - Builds the request payload
 * - Shows progress toasts for each phase
 * - Returns the performTranslations result for caller handling
 */
export async function runTranslations(
  items: PendingReview['items'],
  locales: LocaleTranslationSelection[],
  opts: {
    collectionSlug?: string
    defaultLocale: string
    id?: number | string
  },
) {
  const translationRequest = buildTranslationRequest(items, locales, opts)

  if (!translationRequest.locales.length) {
    toast.info('No fields to sync.')
    return { finished: true, hadError: false }
  }

  const toastId = 'ai-translate-progress'
  return performTranslations(translationRequest, {
    onApplied: (locale) => {
      toast.message(`Translations saved for ${locale}.`, { id: toastId })
    },
    onDone: () => {
      toast.success('All translations synchronized.', { id: toastId })
    },
    onError: (message) => {
      toast.error(message, { id: toastId })
    },
    onMissingBody: () => {
      toast.error('The server did not return any data.', { id: toastId })
    },
    onProgress: ({ completed, locale, total }) => {
      const percentage = total ? Math.round((completed / total) * 100) : 100
      toast.message(`Translating ${locale}… ${completed}/${total} (${percentage}%)`, {
        id: toastId,
      })
    },
    onStart: () => {
      toast.message('Translations starting…', { id: toastId })
    },
    onUnexpectedResponse: (status, statusText, bodyText) => {
      toast.error(`Server error: ${status} ${statusText} ${bodyText}`, { id: toastId })
    },
  })
}
