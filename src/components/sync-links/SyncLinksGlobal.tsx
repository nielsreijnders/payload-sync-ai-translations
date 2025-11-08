'use client'

import { Button, toast } from '@payloadcms/ui'
import * as React from 'react'

import type { BulkLinkSyncResponse } from '../../server/linkSyncTypes.js'

import styles from './SyncLinksGlobal.module.css'
import { runBulkSyncLinks } from './utils/runBulkSyncLinks.js'

type BulkCollectionOption = { label: string; slug: string }

type SyncLinksGlobalProps = {
  collections: BulkCollectionOption[]
}

function formatSummary(summary: BulkLinkSyncResponse['summary']): string {
  const { documentsProcessed, documentsUpdated, replacements, updatedLocales } = summary
  return `Documenten: ${documentsUpdated}/${documentsProcessed} bijgewerkt · Talen: ${updatedLocales} · Links aangepast: ${replacements}`
}

export function SyncLinksGlobal({ collections }: SyncLinksGlobalProps) {
  const [selected, setSelected] = React.useState<string[]>(() => collections.map((c) => c.slug))
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<null | string>(null)
  const [result, setResult] = React.useState<BulkLinkSyncResponse | null>(null)
  const masterId = React.useId()

  React.useEffect(() => {
    setSelected((prev) => {
      const allowed = new Set(collections.map((c) => c.slug))
      const filtered = prev.filter((slug) => allowed.has(slug))
      return filtered.length ? filtered : collections.map((c) => c.slug)
    })
  }, [collections])

  const toggle = React.useCallback((slug: string) => {
    setSelected((prev) => (prev.includes(slug) ? prev.filter((entry) => entry !== slug) : [...prev, slug]))
  }, [])

  const toggleAll = React.useCallback(() => {
    setSelected((prev) => (prev.length === collections.length ? [] : collections.map((c) => c.slug)))
  }, [collections])

  const handleRun = React.useCallback(async () => {
    if (!selected.length) {
      return toast.info('Selecteer minimaal één collectie.')
    }

    try {
      setBusy(true)
      setError(null)
      const response = await runBulkSyncLinks(selected)
      setResult(response)
      const summary = formatSummary(response.summary)
      toast.success(`Bulk link synchronisatie voltooid. ${summary}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Bulk synchronisatie mislukt.'
      setError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }, [selected])

  return (
    <div className={styles.wrapper}>
      <div className={styles.controls}>
        <div className={styles.actions}>
          <label className={styles.masterLabel} htmlFor={masterId}>
            <input
              aria-label="Selecteer alle collecties"
              checked={selected.length === collections.length}
              id={masterId}
              onChange={toggleAll}
              type="checkbox"
            />
            <span>Alle collecties</span>
          </label>
          <Button disabled={busy} onClick={handleRun} type="button">
            {busy ? 'Synchroniseren…' : 'Synchroniseer links'}
          </Button>
        </div>
        <ul className={styles.list}>
          {collections.map((collection) => {
            const inputId = `sync-links-${collection.slug}`
            return (
              <li className={styles.item} key={collection.slug}>
                <label htmlFor={inputId}>
                  <input
                    aria-label={collection.label}
                    checked={selected.includes(collection.slug)}
                    id={inputId}
                    onChange={() => toggle(collection.slug)}
                    type="checkbox"
                  />
                  <span>
                    {collection.label}
                    <span className={styles.slug}> ({collection.slug})</span>
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
        {busy ? <span className={styles.status}>Synchronisatie bezig…</span> : null}
        {error ? <span className={styles.error}>{error}</span> : null}
      </div>

      {result ? (
        <div className={styles.summary}>
          <strong>{formatSummary(result.summary)}</strong>
          {result.summary.missingAlternates.length ? (
            <div>
              <strong>Ontbrekende alternatieven:</strong>{' '}
              {result.summary.missingAlternates
                .map((entry) => `${entry.locale} (${entry.count})`)
                .join(', ')}
            </div>
          ) : null}
          {result.summary.warnings.length ? (
            <div>
              <strong>Waarschuwingen:</strong>
              <ul>
                {result.summary.warnings.map((warning, index) => (
                  <li key={`warn-${index}`}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {result.summary.errors.length ? (
            <div>
              <strong>Fouten:</strong>
              <ul>
                {result.summary.errors.map((message, index) => (
                  <li key={`err-${index}`}>{message}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <ul className={styles.details}>
            {result.details.map((detail) => (
              <li className={styles.detailItem} key={`${detail.collection}-${detail.label}`}>
                <div>
                  <strong>
                    {detail.collection}#{detail.label}
                  </strong>
                </div>
                <div className={styles.detailMeta}>
                  <span className={styles.badge}>
                    {detail.updatedLocales.length ? `Bijgewerkt (${detail.updatedLocales.length})` : 'Geen wijzigingen'}
                  </span>
                  {detail.missingAlternateLocales.length ? (
                    <span className={styles.badge}>
                      Geen alternatieve links: {detail.missingAlternateLocales.join(', ')}
                    </span>
                  ) : null}
                  {detail.errors.length ? (
                    <span className={styles.badge}>Fouten: {detail.errors.length}</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
