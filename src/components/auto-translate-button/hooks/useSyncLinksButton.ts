import { toast, useDocumentForm, useDocumentInfo, useForm, useLocale } from '@payloadcms/ui'
import * as React from 'react'

import type { AutoTranslateButtonProps, LocalizedFieldPatternsInput } from './types.js'

import { looksLikeLink } from '../../../utils/linkDetection.js'
import { buildTranslatableItems } from '../utils/buildTranslatableItems.js'
import { requestLinkSyncPlan } from '../utils/requestLinkSyncPlan.js'
import { runTranslations } from '../utils/runTranslations.js'
import { useLocalizedFieldPatterns } from './useLocalizedFieldPatterns.js'

export function useSyncLinksButton(props: AutoTranslateButtonProps) {
  const { id, collectionSlug, docConfig } = useDocumentInfo()
  const form = useForm()
  const documentForm = useDocumentForm()
  const { code: activeLocale } = useLocale()

  const [busy, setBusy] = React.useState(false)

  const fieldPatterns = useLocalizedFieldPatterns((docConfig as LocalizedFieldPatternsInput)?.fields)
  const defaultLocale = props.defaultLocale || 'en'
  const otherLocales = React.useMemo(
    () =>
      props.locales
        .filter((locale) =>
          typeof locale === 'object' ? locale.code !== defaultLocale : locale !== defaultLocale,
        )
        .map((locale) => (typeof locale === 'string' ? locale : locale.code)),
    [props.locales, defaultLocale],
  )

  const formApi = (documentForm ?? form) as { getData?: () => unknown } | undefined
  const shouldRender = Boolean(
    defaultLocale && collectionSlug && activeLocale === defaultLocale && otherLocales.length,
  )

  const handleClick = React.useCallback(async () => {
    if (!formApi?.getData) {
      return toast.error('Form state is not available.')
    }

    if (!id) {
      return toast.error('Save the document first before syncing links.')
    }

    if (!defaultLocale || !collectionSlug) {
      return toast.error('Localization settings are missing.')
    }

    if (!otherLocales.length) {
      return toast.info('No other languages to synchronize.')
    }

    try {
      setBusy(true)

      const data = formApi.getData()
      const allItems = buildTranslatableItems(data, fieldPatterns)
      const linkItems = allItems.filter((item) => !item.lexical && looksLikeLink(item.text))

      if (!linkItems.length) {
        return toast.info('No links found to synchronize.')
      }

      const plan = await requestLinkSyncPlan({
        collection: collectionSlug,
        defaultLocale,
        id,
        items: linkItems,
        locales: otherLocales,
      })

      if (!plan.locales.length) {
        return toast.info('All links are up to date.')
      }

      const selections = plan.locales
        .map((locale) => {
          const overrides = locale.overrides
            .map((override) => {
              const source = linkItems[override.index]
              if (!source) {
                return null
              }

              return { ...source, text: override.text }
            })
            .filter((value): value is typeof linkItems[number] => Boolean(value))

          return {
            code: locale.code,
            overrides,
            translateIndexes: [],
          }
        })
        .filter((locale) => locale.overrides.length)

      if (!selections.length) {
        return toast.info('All links are up to date.')
      }

      await runTranslations(linkItems, selections, {
        collectionSlug,
        defaultLocale,
        id,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Link synchronization failed.'
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
  ])

  return {
    disabled: busy || !id,
    handleClick,
    shouldRender,
  }
}
