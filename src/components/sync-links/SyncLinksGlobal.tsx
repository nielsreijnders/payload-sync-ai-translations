'use client'

import { Button, toast } from '@payloadcms/ui'
import * as React from 'react'

import type {
  BulkLinkSyncDocumentReport,
  BulkLinkSyncResponse,
} from '../../server/linkSyncTypes.js'

import {
  Badge,
  CheckboxCardGroup,
  ProgressSection,
  StatGrid,
  ToolPage,
  ToolPanel,
  ToolSection,
} from '../shared/ToolUI.js'
import styles from '../shared/ToolUI.module.css'
import { runBulkSyncLinks } from './utils/runBulkSyncLinks.js'

type BulkCollectionOption = { label: string; slug: string }

type SyncLinksGlobalProps = {
  collections: BulkCollectionOption[]
}

function detailKey(detail: BulkLinkSyncDocumentReport, index: number): string {
  const scope = detail.collection ?? detail.global ?? 'document'
  const id = detail.documentId != null ? String(detail.documentId) : String(index)
  return `${scope}:${id}`
}

export function SyncLinksGlobal({ collections }: SyncLinksGlobalProps) {
  const [selected, setSelected] = React.useState<string[]>(() => collections.map((c) => c.slug))
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<null | string>(null)
  const [result, setResult] = React.useState<BulkLinkSyncResponse | null>(null)

  React.useEffect(() => {
    setSelected((prev) => {
      const allowed = new Set(collections.map((c) => c.slug))
      const filtered = prev.filter((slug) => allowed.has(slug))
      return filtered.length ? filtered : collections.map((c) => c.slug)
    })
  }, [collections])

  const toggle = React.useCallback((slug: string) => {
    setSelected((prev) =>
      prev.includes(slug) ? prev.filter((entry) => entry !== slug) : [...prev, slug],
    )
  }, [])

  const toggleAll = React.useCallback(() => {
    setSelected((prev) => (prev.length === collections.length ? [] : collections.map((c) => c.slug)))
  }, [collections])

  const handleRun = React.useCallback(async () => {
    if (!selected.length || busy) {
      return
    }

    try {
      setBusy(true)
      setError(null)
      const response = await runBulkSyncLinks(selected)
      setResult(response)
      toast.success(
        `Link sync complete: ${response.summary.documentsUpdated} of ${response.summary.documentsProcessed} document(s) updated, ${response.summary.replacements} link(s) rewritten.`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Bulk link sync failed.'
      setError(message)
      setResult(null)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }, [busy, selected])

  const summary = result?.summary

  return (
    <ToolPage running={busy}>
      <ToolPanel
        description="Rewrite internal links inside translated documents so each locale points to its own translated URLs. Uses the link alternates collected for every document."
        eyebrow="AI translations"
        title="Link sync"
      >
        <CheckboxCardGroup
          disabled={busy}
          label="Collections"
          onToggle={toggle}
          onToggleAll={toggleAll}
          options={collections.map((c) => ({ key: c.slug, meta: c.slug, title: c.label }))}
          selectedKeys={selected}
        />

        <div className={styles.actions}>
          <Button disabled={busy || !selected.length} onClick={() => void handleRun()} type="button">
            {busy ? 'Syncing…' : 'Sync links'}
          </Button>
        </div>

        {busy ? (
          <ToolSection>
            <ProgressSection completed={0} status="Synchronising links…" total={0} />
          </ToolSection>
        ) : null}

        {error ? (
          <ToolSection>
            <div className={styles.badgeRow}>
              <Badge tone="error">{error}</Badge>
            </div>
          </ToolSection>
        ) : null}
      </ToolPanel>

      {summary ? (
        <ToolPanel
          headerExtra={
            summary.missingAlternates.length ? (
              <div className={styles.badgeRow}>
                {summary.missingAlternates.map((entry) => (
                  <Badge key={entry.locale} tone="warning">
                    {entry.locale}: {entry.count} missing alternate(s)
                  </Badge>
                ))}
              </div>
            ) : undefined
          }
          title="Result"
        >
          <ToolSection>
            <StatGrid
              stats={[
                {
                  label: 'Documents updated',
                  tone: summary.documentsUpdated ? 'success' : 'default',
                  value: `${summary.documentsUpdated}/${summary.documentsProcessed}`,
                },
                { label: 'Locales updated', value: summary.updatedLocales },
                { label: 'Links rewritten', value: summary.replacements },
              ]}
            />
          </ToolSection>

          {summary.warnings.length ? (
            <ToolSection label="Warnings">
              <ul className={styles.plainList}>
                {summary.warnings.map((warning, index) => (
                  <li key={`warn-${index}`}>{warning}</li>
                ))}
              </ul>
            </ToolSection>
          ) : null}

          {summary.errors.length ? (
            <ToolSection label="Errors">
              <ul className={styles.plainList}>
                {summary.errors.map((message, index) => (
                  <li key={`err-${index}`}>{message}</li>
                ))}
              </ul>
            </ToolSection>
          ) : null}

          {result && result.details.length ? (
            <ToolSection label="Documents">
              <ul className={styles.resultList}>
                {result.details.map((detail, index) => (
                  <li className={styles.resultItem} key={detailKey(detail, index)}>
                    <div className={styles.resultRow}>
                      <span className={styles.resultTitle}>{detail.label}</span>
                      <span className={styles.cardMeta}>
                        {detail.collection ?? detail.global}
                        {detail.documentId != null ? `#${detail.documentId}` : ''}
                      </span>
                      <span className={styles.badgeRow}>
                        {detail.updatedLocales.length ? (
                          <Badge tone="success">
                            Updated: {detail.updatedLocales.join(', ')}
                          </Badge>
                        ) : (
                          <Badge>No changes</Badge>
                        )}
                        {detail.missingAlternateLocales.length ? (
                          <Badge tone="warning">
                            Missing alternates: {detail.missingAlternateLocales.join(', ')}
                          </Badge>
                        ) : null}
                        {detail.errors.length ? (
                          <Badge tone="error">
                            {detail.errors.length} error{detail.errors.length === 1 ? '' : 's'}
                          </Badge>
                        ) : null}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </ToolSection>
          ) : null}
        </ToolPanel>
      ) : null}
    </ToolPage>
  )
}
