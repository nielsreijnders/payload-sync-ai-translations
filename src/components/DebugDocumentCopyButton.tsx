'use client'

import { Button, toast, useDocumentForm, useDocumentInfo, useForm } from '@payloadcms/ui'
import { Clipboard } from 'lucide-react'
import * as React from 'react'

import type { AutoTranslateButtonProps, FormApi, LocalizedFieldPatternsInput } from './auto-translate-button/hooks/types.js'
import { useLocalizedFieldPatterns } from './auto-translate-button/hooks/useLocalizedFieldPatterns.js'
import { buildTranslatableItems } from './auto-translate-button/utils/buildTranslatableItems.js'
import { chunkItems } from '../utils/localizedFields.js'
import styles from './AutoTranslateButton.module.css'

export function DebugDocumentCopyButton(props: AutoTranslateButtonProps) {
  const { collectionSlug, docConfig, id } = useDocumentInfo()
  const form = useForm()
  const documentForm = useDocumentForm()
  const [busy, setBusy] = React.useState(false)

  const fieldPatterns = useLocalizedFieldPatterns(
    (docConfig as LocalizedFieldPatternsInput)?.fields,
  )

  const formApi = (documentForm ?? form) as FormApi | undefined

  const handleCopy = React.useCallback(async () => {
    if (!formApi?.getData) {
      toast.error('Form state is not available.')
      return
    }

    if (!collectionSlug) {
      toast.error('Localization settings are missing.')
      return
    }

    if (!navigator?.clipboard?.writeText) {
      toast.error('Clipboard API is not available in this browser.')
      return
    }

    try {
      setBusy(true)

      const data = formApi.getData()
      const items = buildTranslatableItems(data, fieldPatterns)
      const chunked = chunkItems(items)

      const defaultLocale =
        typeof props.defaultLocale === 'string'
          ? props.defaultLocale
          : props.defaultLocale?.code ?? null

      const payload = {
        meta: {
          collectionSlug,
          defaultLocale,
          documentId: id ?? null,
          fieldPatterns,
          locales: props.locales,
        },
        documentData: data,
        translatableItems: items,
        chunks: chunked,
      }

      const serialized = JSON.stringify(payload, null, 2)
      await navigator.clipboard.writeText(serialized)

      toast.success('Document translation debug info copied to clipboard.')
    } catch (error) {
      console.error('Failed to copy translation debug info', error)
      toast.error('Failed to copy translation debug info.')
    } finally {
      setBusy(false)
    }
  }, [collectionSlug, fieldPatterns, formApi, id, props.defaultLocale, props.locales])

  return (
    <Button disabled={busy} onClick={handleCopy} type="button" variant="secondary">
      <span className={styles.buttonContent}>
        <Clipboard size={14} />
        Copy translation debug info
      </span>
    </Button>
  )
}
