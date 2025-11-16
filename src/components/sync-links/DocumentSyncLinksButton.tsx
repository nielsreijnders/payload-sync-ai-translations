'use client'

import type { LocalizationConfig, TypedLocale } from 'payload'

import { Button, toast, useDocumentInfo, useLocale } from '@payloadcms/ui'
import { Link2 } from 'lucide-react'
import * as React from 'react'

import type { LinkSyncResult } from '../../server/linkSyncTypes.js'

type SyncLinksButtonProps = {
  defaultLocale: TypedLocale
  locales: LocalizationConfig['locales']
}

function getLocaleCode(locale: TypedLocale): string {
  return typeof locale === 'string' ? locale : (locale as any).code
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
  return `${rest.reverse().join(', ')} en ${last}`
}

function buildSummary(result: LinkSyncResult): string {
  const localeCount = result.updatedLocales.length
  const replacementCount = result.replacements
  if (!localeCount) {
    return 'Geen wijzigingen nodig; alle links zijn al up-to-date.'
  }

  const localeLabel = localeCount === 1 ? 'taal' : 'talen'
  const replacementLabel = replacementCount === 1 ? 'vervanging' : 'vervangingen'
  return `Links gesynchroniseerd voor ${localeCount} ${localeLabel} (${replacementCount} ${replacementLabel}).`
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
      return toast.error('Documentgegevens ontbreken.')
    }

    if (collectionSlug && !id) {
      return toast.error('Documentgegevens ontbreken.')
    }

    try {
      setBusy(true)
      const response = await fetch('/api/ai-links/sync', {
        body: JSON.stringify({
          collection: collectionSlug,
          global: globalSlug,
          id,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      const json = await response.json().catch(() => ({}))
      if (!response.ok) {
        const message = typeof json?.message === 'string' ? json.message : 'Synchronisatie mislukt.'
        throw new Error(message)
      }

      const result = json?.result as LinkSyncResult | undefined
      if (!result) {
        throw new Error('Ongeldige serverrespons ontvangen.')
      }

      if (result.warnings.length) {
        toast.info(`Waarschuwingen: ${result.warnings.join(' | ')}`)
      }

      if (result.errors.length) {
        toast.error(result.errors[0] ?? 'Er trad een fout op tijdens het bijwerken van een taal.')
      }

      if (result.updatedLocales.length) {
        toast.success(buildSummary(result))
      } else {
        toast.info(buildSummary(result))
      }

      if (result.missingAlternateLocales.length) {
        toast.info(
          `Geen alternatieve links gevonden voor: ${formatList(result.missingAlternateLocales)}.`,
        )
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Synchronisatie mislukt.'
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }, [collectionSlug, globalSlug, id])

  if (!shouldRender) {
    return null
  }

  return (
    <Button disabled={busy} onClick={handleClick} type="button">
      <span style={{ alignItems: 'center', display: 'inline-flex', gap: '0.35rem' }}>
        <Link2 size={14} />
        Synchroniseer links
      </span>
    </Button>
  )
}
