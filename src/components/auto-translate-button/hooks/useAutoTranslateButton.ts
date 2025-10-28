import { toast, useDocumentForm, useDocumentInfo, useForm, useLocale } from '@payloadcms/ui'
import * as React from 'react'

import type {
  AutoTranslateButtonProps,
  FormApi,
  LocalizedFieldPatternsInput,
  PendingReview,
} from './types.js'

import { buildTranslatableItems } from '../utils/buildTranslatableItems.js'
import { prepareLocalesForTranslation } from '../utils/prepareLocalesForTranslation.js'
import { requiresHumanReview, sanitizeLocalesFromReviewResponse } from '../utils/reviewHelpers.js'
import { applyLocaleOverride, applyLocaleSkip } from '../utils/reviewState.js'
import { runTranslations } from '../utils/runTranslations.js'

// import { prepareLocalesForTranslation } from '../utils/prepareLocalesForTranslation'
import { requestTranslationReview } from '../utils/requestTranslationReview.js'
import { useLocalizedFieldPatterns } from './useLocalizedFieldPatterns.js'
// import { requiresHumanReview, sanitizeLocalesFromReviewResponse } from './utils/reviewHelpers'
// import { applyLocaleOverride, applyLocaleSkip } from './utils/reviewState'
// import { runTranslations } from './utils/runTranslations'

export function useAutoTranslateButton(props: AutoTranslateButtonProps) {
  // ---- Document & form context
  const { id, collectionSlug, docConfig } = useDocumentInfo()
  const form = useForm()
  const documentForm = useDocumentForm()
  const { code: activeLocale } = useLocale()

  // ---- Local UI state
  const [busy, setBusy] = React.useState(false)
  const [modalBusy, setModalBusy] = React.useState(false)
  const [pendingReview, setPendingReview] = React.useState<null | PendingReview>(null)

  // ---- Config-derived values
  const fieldPatterns = useLocalizedFieldPatterns(
    (docConfig as LocalizedFieldPatternsInput)?.fields,
  )
  const defaultLocale = props.defaultLocale || 'en'
  const otherLocales = React.useMemo(
    () =>
      props.locales
        .filter((locale) =>
          typeof locale === 'object' ? locale.code !== defaultLocale : locale !== defaultLocale,
        )
        .map((l) => l),
    [props.locales, defaultLocale],
  )

  const formApi = (documentForm ?? form) as FormApi | undefined
  const shouldRender = Boolean(
    defaultLocale && collectionSlug && activeLocale === defaultLocale && otherLocales.length,
  )

  // ---- Event handlers
  const handleClick = React.useCallback(async () => {
    // Fast-fail validations
    if (!formApi?.getData) {
      return toast.error('Form state is not available.')
    }
    if (!id) {
      return toast.error('Save the document first before translating.')
    }
    if (!defaultLocale || !collectionSlug) {
      return toast.error('Localization settings are missing.')
    }
    if (!otherLocales.length) {
      return toast.info('No other languages to synchronize.')
    }

    try {
      setBusy(true)

      // 1) Collect translatable fields from form data
      const data = formApi.getData()
      const items = buildTranslatableItems(data, fieldPatterns)

      if (items) {
        console.log('Translatable items:', items)
        return console.log('end here for debugging')
      }

      if (!items.length) {
        return toast.info('No translatable fields found.')
      }

      // 2) Ask server what needs attention (mismatches, suggestions, etc.)
      const review = await requestTranslationReview({
        id: typeof id === 'string' ? id : String(id),
        collection: collectionSlug,
        defaultLocale,
        items,
        // Oopsie for later
        locales: otherLocales as any,
      })

      // 3) Normalize/sanitize server response
      const localesToTranslate = sanitizeLocalesFromReviewResponse(items.length, review.locales)

      if (!localesToTranslate.length) {
        return toast.info('All translations are up-to-date.')
      }

      // 4) If a human should review, open review modal/state
      if (requiresHumanReview(localesToTranslate)) {
        setPendingReview({ items, locales: localesToTranslate })
        return toast.info('Check missing information before proceeding with translations.')
      }

      // 5) Otherwise, run translations immediately
      const selections = prepareLocalesForTranslation(items, localesToTranslate)
      const { finished, hadError } = await runTranslations(items, selections, {
        id,
        collectionSlug,
        defaultLocale,
      })

      if (!hadError && !finished) {
        toast.success('Translations synchronized.')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Translation failed.'
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }, [formApi, id, defaultLocale, collectionSlug, otherLocales, fieldPatterns])

  const confirmReview = React.useCallback(async () => {
    if (!pendingReview) {
      return
    }
    try {
      setModalBusy(true)
      setBusy(true)

      const selections = prepareLocalesForTranslation(pendingReview.items, pendingReview.locales)
      if (!selections.length) {
        setPendingReview(null)
        return toast.info('No fields selected for translation.')
      }

      const { finished, hadError } = await runTranslations(pendingReview.items, selections, {
        id,
        collectionSlug,
        defaultLocale,
      })

      if (!hadError && !finished) {
        toast.success('Translations synchronized.')
      }

      setPendingReview(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Translation failed.'
      toast.error(message)
    } finally {
      setBusy(false)
      setModalBusy(false)
    }
  }, [pendingReview, collectionSlug, id, defaultLocale])

  const cancelReview = React.useCallback(() => setPendingReview(null), [])

  const updateLocaleOverride = React.useCallback((code: string, index: number, value: string) => {
    setPendingReview((prev) => applyLocaleOverride(prev, code, index, value))
  }, [])

  const updateLocaleSkip = React.useCallback((code: string, index: number, skip: boolean) => {
    setPendingReview((prev) => applyLocaleSkip(prev, code, index, skip))
  }, [])

  return {
    // actions
    cancelReview,
    confirmReview,
    handleClick,
    updateLocaleOverride,
    updateLocaleSkip,

    // state
    disabled: busy || !id,
    modalBusy,
    pendingReview,
    shouldRender,
  }
}
