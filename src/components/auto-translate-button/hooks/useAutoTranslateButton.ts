import type { LocalizationConfig, TypedLocale } from 'payload'

import { toast, useDocumentForm, useDocumentInfo, useForm, useLocale } from '@payloadcms/ui'
import * as React from 'react'

import type { TranslateReviewLocale } from '../../../server/types.js'

import { type AnyField } from '../../../utils/localizedFields.js'
import {
  buildTranslationRequest,
  type LocalePreparationInput,
  type LocaleTranslationSelection,
  prepareLocalesForTranslation,
} from '../../../utils/translationPlan.js'
import { buildTranslatableItems } from '../utils/buildTranslatableItems.js'
import { performTranslations } from '../utils/performTranslations.js'
import { requestTranslationReview } from '../utils/requestTranslationReview.js'
import { useLocalizedFieldPatterns } from './useLocalizedFieldPatterns.js'

export type AutoTranslateButtonProps = {
  defaultLocale: TypedLocale
  locales: LocalizationConfig['locales']
}

export type FormApi = ReturnType<typeof useForm>

type PendingReviewLocale = {
  overrides: Record<number, string>
  skipped: number[]
} &
  LocalePreparationInput &
  TranslateReviewLocale

type PendingReview = {
  items: ReturnType<typeof buildTranslatableItems>
  locales: PendingReviewLocale[]
}

export function useAutoTranslateButton(props: AutoTranslateButtonProps) {
  const { defaultLocale: configDefaultLocale, locales: configLocales } = props
  const { id, collectionSlug, docConfig } = useDocumentInfo()
  const form = useForm()
  const documentForm = useDocumentForm()
  const { code: activeLocale } = useLocale()
  const [busy, setBusy] = React.useState(false)
  const [modalBusy, setModalBusy] = React.useState(false)
  const [pendingReview, setPendingReview] = React.useState<null | PendingReview>(null)

  const fieldPatterns = useLocalizedFieldPatterns((docConfig as { fields?: AnyField[] })?.fields)

  const defaultLocale = configDefaultLocale || 'en'
  const otherLocales = React.useMemo(
    () =>
      configLocales
        .map((locale) => (typeof locale === 'string' ? locale : locale?.code))
        .filter(
          (code): code is string => typeof code === 'string' && code.length > 0 && code !== defaultLocale,
        ),
    [configLocales, defaultLocale],
  )

  const formApi = (documentForm ?? form) as FormApi | undefined

  const runTranslations = React.useCallback(
    async (items: PendingReview['items'], locales: LocaleTranslationSelection[]) => {
      if (!collectionSlug) {
        throw new Error('Localization settings are missing.')
      }

      if (!id) {
        throw new Error('Document ID is missing.')
      }

      const identifier = typeof id === 'string' ? id : String(id)

      const translationRequest = buildTranslationRequest({
        collection: collectionSlug,
        defaultLocale,
        documentID: identifier,
        items,
        locales,
      })

      if (!translationRequest) {
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
    },
    [collectionSlug, defaultLocale, id],
  )

  const handleClick = React.useCallback(async () => {
    if (!formApi?.getData) {
      toast.error('Form state is not available.')
      return
    }

    if (!id) {
      toast.error('Save the document first before translating.')
      return
    }

    if (!defaultLocale || !collectionSlug) {
      toast.error('Localization settings are missing.')
      return
    }

    if (!otherLocales.length) {
      toast.info('No other languages to synchronize.')
      return
    }

    try {
      setBusy(true)

      const data = formApi.getData()
      const items = buildTranslatableItems(data, fieldPatterns)

      if (!items.length) {
        toast.info('No translatable fields found.')
        return
      }

      const review = await requestTranslationReview({
        id: typeof id === 'string' ? id : String(id),
        collection: collectionSlug,
        defaultLocale,
        items,
        locales: otherLocales,
      })

      const localesToTranslate: PendingReviewLocale[] = review.locales
        .map((locale) => {
          const sanitizedIndexes = Array.from(new Set(locale.translateIndexes)).filter(
            (index) => Number.isInteger(index) && index >= 0 && index < items.length,
          )

          const overrides: Record<number, string> = {}
          for (const suggestion of locale.suggestions ?? []) {
            if (!Number.isInteger(suggestion.index)) {
              continue
            }

            const value = typeof suggestion.text === 'string' ? suggestion.text : ''
            if (value.trim()) {
              overrides[suggestion.index] = value
            }
          }

          return {
            ...locale,
            overrides,
            skipped: [],
            translateIndexes: sanitizedIndexes,
          }
        })
        .filter((locale) => locale.translateIndexes.length || Object.keys(locale.overrides).length)

      if (!localesToTranslate.length) {
        toast.info('All translations are up-to-date.')
        return
      }

      const requiresReview = localesToTranslate.some(
        (locale) => (locale.mismatches?.length ?? 0) > 0 && locale.existingCount > 0,
      )

      if (requiresReview) {
        setPendingReview({ items, locales: localesToTranslate })
        toast.info('Check missing information before proceeding with translations.')
        return
      }

      const preparedLocales = prepareLocalesForTranslation(items, localesToTranslate)
      const { finished, hadError } = await runTranslations(items, preparedLocales)

      if (!hadError && !finished) {
        toast.success('Translations synchronized.')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Translation failed.'
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }, [
    collectionSlug,
    defaultLocale,
    fieldPatterns,
    formApi,
    id,
    otherLocales,
    prepareLocalesForTranslation,
    runTranslations,
  ])

  const updateLocaleOverride = React.useCallback((code: string, index: number, value: string) => {
    setPendingReview((previous) => {
      if (!previous) {
        return previous
      }

      return {
        ...previous,
        locales: previous.locales.map((locale) => {
          if (locale.code !== code) {
            return locale
          }

          const overrides = { ...locale.overrides }
          if (!value.trim()) {
            delete overrides[index]
          } else {
            overrides[index] = value
          }

          return { ...locale, overrides }
        }),
      }
    })
  }, [])

  const updateLocaleSkip = React.useCallback((code: string, index: number, skip: boolean) => {
    setPendingReview((previous) => {
      if (!previous) {
        return previous
      }

      return {
        ...previous,
        locales: previous.locales.map((locale) => {
          if (locale.code !== code) {
            return locale
          }

          const skipped = new Set(locale.skipped)
          const overrides = { ...locale.overrides }
          if (skip) {
            skipped.add(index)
            delete overrides[index]
          } else {
            skipped.delete(index)
          }

          return { ...locale, overrides, skipped: Array.from(skipped) }
        }),
      }
    })
  }, [])

  const confirmReview = React.useCallback(async () => {
    if (!pendingReview) {
      return
    }

    try {
      setModalBusy(true)
      setBusy(true)

      const locales = prepareLocalesForTranslation(pendingReview.items, pendingReview.locales)

      if (!locales.length) {
        toast.info('No fields selected for translation.')
        setPendingReview(null)
        return
      }

      const { finished, hadError } = await runTranslations(pendingReview.items, locales)
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
  }, [pendingReview, prepareLocalesForTranslation, runTranslations])

  const cancelReview = React.useCallback(() => {
    setPendingReview(null)
  }, [])

  const shouldRender = Boolean(
    defaultLocale && collectionSlug && activeLocale === defaultLocale && otherLocales.length,
  )

  return {
    cancelReview,
    confirmReview,
    disabled: busy || !id,
    handleClick,
    modalBusy,
    pendingReview,
    shouldRender,
    updateLocaleOverride,
    updateLocaleSkip,
  }
}
