'use client'

import type { LocalizationConfig, TypedLocale } from 'payload'

import { toast, useDocumentInfo, useLocale } from '@payloadcms/ui'
import { Link2 } from 'lucide-react'
import * as React from 'react'

import type { LinkSyncResult } from '../../server/linkSyncTypes.js'

import { IconTooltipButton } from '../shared/IconTooltipButton.js'

type SyncLinksButtonProps = {
  defaultLocale: { code: string } | TypedLocale
  locales: LocalizationConfig['locales']
}

function getLocaleCode(locale: SyncLinksButtonProps['defaultLocale']): string {
  if (typeof locale === 'string') {
    return locale
  }

  return locale?.code ?? ''
}

function getLocaleCodes(locales: LocalizationConfig['locales']): string[] {
  return (locales ?? [])
    .map((entry) => (typeof entry === 'string' ? entry : entry.code))
    .filter((value): value is string => Boolean(value))
}

function formatList(values: string[]): string {
  if (values.length <= 1) {
    return values[0] ?? ''
  }

  const [last, ...rest] = values.slice().reverse()
  return `${rest.reverse().join(', ')} and ${last}`
}

function buildSummary(result: LinkSyncResult): string {
  const localeCount = result.updatedLocales.length
  const replacementCount = result.replacements
  if (!localeCount) {
    return 'No changes needed; all links are already up to date.'
  }

  const localeLabel = localeCount === 1 ? 'locale' : 'locales'
  const replacementLabel = replacementCount === 1 ? 'replacement' : 'replacements'
  return `Links synced for ${localeCount} ${localeLabel} (${replacementCount} ${replacementLabel}).`
}

export function DocumentSyncLinksButton(props: SyncLinksButtonProps) {
  const { id, collectionSlug, globalSlug } = useDocumentInfo()
  const { code: activeLocale } = useLocale()

  const defaultLocaleCode = React.useMemo(
    () => getLocaleCode(props.defaultLocale),
    [props.defaultLocale],
  )
  const allLocaleCodes = React.useMemo(() => getLocaleCodes(props.locales), [props.locales])

  const otherLocales = React.useMemo(
    () => allLocaleCodes.filter((code) => code && code !== defaultLocaleCode),
    [allLocaleCodes, defaultLocaleCode],
  )

  const shouldRender = Boolean(
    (collectionSlug || globalSlug) &&
      defaultLocaleCode &&
      activeLocale === defaultLocaleCode &&
      otherLocales.length &&
      (collectionSlug ? Boolean(id) : true),
  )

  const [busy, setBusy] = React.useState(false)

  const handleClick = React.useCallback(async () => {
    if (!collectionSlug && !globalSlug) {
      return toast.error('Document details are missing.')
    }

    if (collectionSlug && !id) {
      return toast.error('Document details are missing.')
    }

    try {
      setBusy(true)
      const response = await fetch('/api/ai-links/sync', {
        body: JSON.stringify({
          id,
          collection: collectionSlug,
          global: globalSlug,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      const json = await response.json().catch(() => ({}))
      if (!response.ok) {
        const message = typeof json?.message === 'string' ? json.message : 'Link sync failed.'
        throw new Error(message)
      }

      const result = json?.result as LinkSyncResult | undefined
      if (!result) {
        throw new Error('Received an invalid server response.')
      }

      if (result.warnings.length) {
        toast.info(`Warnings: ${result.warnings.join(' | ')}`)
      }

      if (result.errors.length) {
        toast.error(result.errors[0] ?? 'An error occurred while updating a locale.')
      }

      if (result.updatedLocales.length) {
        toast.success(buildSummary(result))
      } else {
        toast.info(buildSummary(result))
      }

      if (result.missingAlternateLocales.length) {
        toast.info(`No alternate links found for: ${formatList(result.missingAlternateLocales)}.`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Link sync failed.'
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }, [collectionSlug, globalSlug, id])

  if (!shouldRender) {
    return null
  }

  return (
    <IconTooltipButton
      disabled={busy}
      icon={<Link2 size={18} strokeWidth={1.5} />}
      label="Sync links"
      onClick={handleClick}
    />
  )
}
