import type { LocalizationConfig } from 'payload/dist/config/types.js'

import { toast, useDocumentForm, useDocumentInfo, useForm, useLocale } from '@payloadcms/ui'
import * as React from 'react'

import type { TranslateReviewLocale } from '../../../server/types.js'

import { type AnyField, chunkItems } from '../../../utils/localizedFields.js'
import { buildTranslatableItems } from '../utils/buildTranslatableItems.js'
import { performTranslations } from '../utils/performTranslations.js'
import { requestTranslationReview } from '../utils/requestTranslationReview.js'
import { useLocalizedFieldPatterns } from './useLocalizedFieldPatterns.js'

type LocalizationLocale = LocalizationConfig extends { locales: Array<infer Locale> }
  ? Locale
  : never

type LocaleInput = ReadonlyArray<LocalizationLocale> | string[]

export type AutoTranslateButtonProps = {
  defaultLocale?: null | string
  locales?: LocaleInput | null
}

function extractLocaleCode(locale: unknown): null | string {
  if (typeof locale === 'string') {
    return locale
  }

  if (locale && typeof locale === 'object') {
    const candidate = locale as { code?: unknown; value?: unknown }

    if (typeof candidate.code === 'string' && candidate.code.length > 0) {
      return candidate.code
    }

    if (typeof candidate.value === 'string' && candidate.value.length > 0) {
      return candidate.value
    }
  }

  return null
}

function normalizeLocaleCodes(locales: AutoTranslateButtonProps['locales']): string[] {
  if (!Array.isArray(locales)) {
    return []
  }

  const codes = locales
    .map((locale) => extractLocaleCode(locale))
    .filter((locale): locale is string => typeof locale === 'string' && locale.length > 0)

  return Array.from(new Set(codes))
}

export type FormApi = ReturnType<typeof useForm>

type PendingReviewLocale = {
  overrides: Record<number, string>
  skipped: number[]
} & TranslateReviewLocale

type PendingReview = {
  items: ReturnType<typeof buildTranslatableItems>
  locales: PendingReviewLocale[]
}

type LocaleTranslationSelection = {
  code: string
  overrides: PendingReview['items'][number][]
  translateIndexes: number[]
}

export function useAutoTranslateButton(props: AutoTranslateButtonProps) {
  const localeCodes = React.useMemo(() => normalizeLocaleCodes(props.locales), [props.locales])
  const defaultLocale = React.useMemo(() => {
    if (typeof props.defaultLocale === 'string' && props.defaultLocale.length > 0) {
      return props.defaultLocale
    }

    return localeCodes[0] ?? ''
  }, [localeCodes, props.defaultLocale])
  const otherLocales = React.useMemo(
    () => localeCodes.filter((locale) => locale !== defaultLocale),
    [defaultLocale, localeCodes],
  )
  const { id, collectionSlug, docConfig } = useDocumentInfo()
  const form = useForm()
  const documentForm = useDocumentForm()
  const { code: activeLocale } = useLocale()
  const [busy, setBusy] = React.useState(false)
  const [modalBusy, setModalBusy] = React.useState(false)
  const [pendingReview, setPendingReview] = React.useState<null | PendingReview>(null)

  const fieldPatterns = useLocalizedFieldPatterns((docConfig as { fields?: AnyField[] })?.fields)

  const formApi = (documentForm ?? form) as FormApi | undefined

  const prepareLocalesForTranslation = React.useCallback(
    (
      items: PendingReview['items'],
      locales: PendingReviewLocale[],
    ): LocaleTranslationSelection[] => {
      return locales
        .map((locale) => {
          const skipSet = new Set(locale.skipped)
          const overrideEntries = Object.entries(locale.overrides)
            .map(([key, value]) => {
              const parsedIndex = Number(key)
              if (!Number.isInteger(parsedIndex)) {
                return null
              }

              const item = items[parsedIndex]
              if (!item) {
                return null
              }

              const text = value.trim()
              if (!text) {
                return null
              }

              return { index: parsedIndex, item: { ...item, text } }
            })
            .filter((entry): entry is { index: number; item: PendingReview['items'][number] } =>
              Boolean(entry),
            )

          const overrideIndexes = new Set(overrideEntries.map((entry) => entry.index))

          const translateIndexes = Array.from(new Set(locale.translateIndexes))
            .filter((index) => Number.isInteger(index) && index >= 0 && index < items.length)
            .filter((index) => !skipSet.has(index) && !overrideIndexes.has(index))

          return {
            code: locale.code,
            overrides: overrideEntries.map((entry) => entry.item),
            translateIndexes,
          }
        })
        .filter((locale) => locale.translateIndexes.length || locale.overrides.length)
    },
    [],
  )

  const buildTranslationRequest = React.useCallback(
    (items: PendingReview['items'], locales: LocaleTranslationSelection[]) => {
      if (!collectionSlug) {
        throw new Error('Localization settings are missing.')
      }

      if (!id) {
        throw new Error('Document ID is missing.')
      }

      const identifier = typeof id === 'string' ? id : String(id)
      const localesWithChunks = locales
        .map((locale) => {
          const selected = locale.translateIndexes
            .filter((index) => Number.isInteger(index) && index >= 0 && index < items.length)
            .map((index) => items[index])

          return {
            chunks: chunkItems(selected),
            code: locale.code,
            overrides: locale.overrides,
          }
        })
        .filter((locale) => locale.chunks.length || (locale.overrides?.length ?? 0) > 0)

      return {
        id: identifier,
        collection: collectionSlug,
        defaultLocale,
        locales: localesWithChunks,
      }
    },
    [collectionSlug, defaultLocale, id],
  )

  const runTranslations = React.useCallback(
    async (items: PendingReview['items'], locales: LocaleTranslationSelection[]) => {
      const translationRequest = buildTranslationRequest(items, locales)

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
    },
    [buildTranslationRequest],
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
