'use client'

import { Button, useConfig } from '@payloadcms/ui'
import * as React from 'react'

import type {
  LocaleSyncStatus,
  SyncStatusDocument,
  SyncStatusScanEvent,
} from '../../server/syncStatusTypes.js'
import type { BulkStreamEvent } from '../../server/translationTypes.js'

import { postBulkStream } from '../shared/streamBulkEvents.js'
import {
  Badge,
  CheckboxCardGroup,
  LogViewer,
  ProgressSection,
  StatGrid,
  ToolPage,
  ToolPanel,
  ToolSection,
  useToolLogs,
} from '../shared/ToolUI.js'
import toolStyles from '../shared/ToolUI.module.css'
import styles from './TranslationStatusGlobal.module.css'
import { runSyncStatusScan } from './utils/runSyncStatusScan.js'

type TargetOption = { label: string; slug: string }

type TranslationStatusGlobalProps = {
  collections: TargetOption[]
  defaultLocale: string
  globals?: TargetOption[]
  locales: string[]
}

type StatusFilter = 'all' | 'needs-sync' | 'synced'

function documentNeedsSync(document: SyncStatusDocument): boolean {
  return document.locales.some((locale) => locale.status !== 'synced')
}

function documentKey(document: SyncStatusDocument): string {
  return document.global
    ? `global:${document.global}`
    : `${document.collection}:${String(document.id)}`
}

function localeBadgeTone(status: LocaleSyncStatus['status']): 'error' | 'success' | 'warning' {
  if (status === 'synced') {
    return 'success'
  }
  if (status === 'never-synced') {
    return 'error'
  }
  return 'warning'
}

function localeBadgeText(locale: LocaleSyncStatus): string {
  if (locale.status === 'synced') {
    return `${locale.locale} ✓`
  }
  if (locale.status === 'never-synced') {
    return `${locale.locale} · never synced`
  }
  return `${locale.locale} · ${locale.changedFields} changed`
}

function formatSyncedAt(value?: string): string {
  if (!value) {
    return 'never'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return 'never'
  }

  return date.toLocaleString()
}

export function TranslationStatusGlobal({
  collections,
  defaultLocale,
  globals = [],
  locales,
}: TranslationStatusGlobalProps) {
  const {
    config: { routes },
  } = useConfig()

  const allTargets = React.useMemo(
    () => [
      ...collections.map((entry) => ({
        slug: entry.slug,
        type: 'collection' as const,
        key: `collection:${entry.slug}`,
        label: entry.label,
      })),
      ...globals.map((entry) => ({
        slug: entry.slug,
        type: 'global' as const,
        key: `global:${entry.slug}`,
        label: entry.label,
      })),
    ],
    [collections, globals],
  )

  const [selectedKeys, setSelectedKeys] = React.useState<string[]>(() =>
    allTargets.map((entry) => entry.key),
  )
  const [scanning, setScanning] = React.useState(false)
  const [syncing, setSyncing] = React.useState(false)
  const [hasScanned, setHasScanned] = React.useState(false)
  const [documents, setDocuments] = React.useState<SyncStatusDocument[]>([])
  const [progress, setProgress] = React.useState({ completed: 0, total: 0 })
  const [currentTask, setCurrentTask] = React.useState('Waiting to start…')
  const [filter, setFilter] = React.useState<StatusFilter>('needs-sync')
  const [search, setSearch] = React.useState('')
  const [selectedDocKeys, setSelectedDocKeys] = React.useState<string[]>([])
  const log = useToolLogs()

  React.useEffect(() => {
    setSelectedKeys((previous) => {
      const allowed = new Set(allTargets.map((entry) => entry.key))
      const filtered = previous.filter((key) => allowed.has(key))
      return filtered.length ? filtered : allTargets.map((entry) => entry.key)
    })
  }, [allTargets])

  const busy = scanning || syncing

  const toggleTarget = (key: string) =>
    setSelectedKeys((previous) =>
      previous.includes(key) ? previous.filter((entry) => entry !== key) : [...previous, key],
    )

  const toggleAllTargets = () =>
    setSelectedKeys((previous) =>
      previous.length === allTargets.length ? [] : allTargets.map((entry) => entry.key),
    )

  const handleScanEvent = (event: SyncStatusScanEvent) => {
    switch (event.type) {
      case 'collection-error':
        log.addLog(`${event.collection}: ${event.message}`, 'error')
        break
      case 'collection-start':
        setCurrentTask(`Scanning ${event.label} (${event.totalDocuments} document(s))…`)
        break
      case 'document-result':
        setDocuments((previous) => [...previous, event.document])
        setProgress((previous) => ({
          completed: Math.min(previous.total, previous.completed + 1),
          total: previous.total,
        }))
        break
      case 'error':
        log.addLog(event.message || 'Sync status scan failed.', 'error')
        setCurrentTask('Scan failed.')
        setScanning(false)
        break
      case 'scan-complete':
        log.addLog(
          `Scan finished: ${event.outOfSync} of ${event.processed} document(s) need a sync.`,
          event.outOfSync ? 'skip' : 'success',
        )
        setProgress((previous) => ({ completed: event.processed, total: previous.total }))
        setCurrentTask('Scan complete.')
        setScanning(false)
        break
      case 'scan-start':
        setProgress({ completed: 0, total: event.totalDocuments })
        log.addLog(
          `Scanning ${event.totalCollections} target(s) / ${event.totalDocuments} document(s).`,
        )
        break
    }
  }

  const startScan = async () => {
    if (busy || !selectedKeys.length) {
      return
    }

    const scanTargets = {
      collections: allTargets
        .filter((entry) => entry.type === 'collection' && selectedKeys.includes(entry.key))
        .map((entry) => entry.slug),
      globals: allTargets
        .filter((entry) => entry.type === 'global' && selectedKeys.includes(entry.key))
        .map((entry) => entry.slug),
    }

    if (!scanTargets.collections.length && !scanTargets.globals.length) {
      return
    }

    setScanning(true)
    setHasScanned(true)
    setDocuments([])
    setSelectedDocKeys([])
    setProgress({ completed: 0, total: 0 })
    setCurrentTask('Preparing scan…')

    try {
      await runSyncStatusScan(scanTargets, handleScanEvent)
    } catch (error) {
      log.addLog(error instanceof Error ? error.message : 'Sync status scan failed.', 'error')
      setCurrentTask('Scan failed.')
      setScanning(false)
    }
  }

  const handleBulkEvent = (event: BulkStreamEvent) => {
    switch (event.type) {
      case 'bulk-complete':
        log.addLog(
          `Sync finished. Processed ${event.processed}, skipped ${event.skipped}, failed ${event.failed}.`,
          event.failed ? 'error' : 'success',
        )
        setCurrentTask('Sync complete — refreshing overview…')
        setSyncing(false)
        // Refresh the overview so the new sync state is visible right away.
        void startScan()
        break
      case 'bulk-start':
        setProgress({ completed: 0, total: event.totalDocuments })
        log.addLog(`Syncing ${event.totalDocuments} document(s).`)
        setCurrentTask('Preparing sync…')
        break
      case 'document-error':
        log.addLog(`Failed ${event.collection}#${event.id}: ${event.message}.`, 'error')
        setProgress((previous) => ({
          completed: Math.min(previous.total, previous.completed + 1),
          total: previous.total,
        }))
        break
      case 'document-skipped':
        log.addLog(
          `Skipped ${event.collection}#${event.id}: ${event.reason || 'No action required.'}`,
          'skip',
        )
        setProgress((previous) => ({
          completed: Math.min(previous.total, previous.completed + 1),
          total: previous.total,
        }))
        break
      case 'document-start':
        setCurrentTask(`Syncing ${event.collection}#${event.id}…`)
        break
      case 'document-success':
        log.addLog(`Synced ${event.collection}#${event.id}.`, 'success')
        setProgress((previous) => ({
          completed: Math.min(previous.total, previous.completed + 1),
          total: previous.total,
        }))
        break
      case 'error':
        log.addLog(event.message || 'Sync failed.', 'error')
        setCurrentTask('Sync failed.')
        setSyncing(false)
        break
      default:
        break
    }
  }

  const documentByKey = React.useMemo(() => {
    const map = new Map<string, SyncStatusDocument>()
    for (const document of documents) {
      map.set(documentKey(document), document)
    }
    return map
  }, [documents])

  const syncableSelection = React.useMemo(
    () =>
      selectedDocKeys
        .map((key) => documentByKey.get(key))
        .filter(
          (document): document is SyncStatusDocument =>
            Boolean(document?.collection) && document?.id != null && documentNeedsSync(document!),
        ),
    [documentByKey, selectedDocKeys],
  )

  const startSync = async () => {
    if (busy || !syncableSelection.length) {
      return
    }

    const grouped = new Map<string, Array<number | string>>()
    for (const document of syncableSelection) {
      if (!document.collection || document.id == null) {
        continue
      }
      if (!grouped.has(document.collection)) {
        grouped.set(document.collection, [])
      }
      grouped.get(document.collection)?.push(document.id)
    }

    const targetLocales = locales.filter((code) => code !== defaultLocale)
    const ok = window.confirm(
      `Sync ${syncableSelection.length} document(s) from ${defaultLocale} to ${targetLocales.join(', ')}?`,
    )
    if (!ok) {
      return
    }

    setSyncing(true)
    setProgress({ completed: 0, total: 0 })
    setCurrentTask('Starting sync…')

    try {
      await postBulkStream(
        '/api/ai-translate/bulk',
        {
          collections: Array.from(grouped.keys()),
          documents: Object.fromEntries(grouped.entries()),
        },
        handleBulkEvent,
        'Bulk translation request failed.',
      )
    } catch (error) {
      log.addLog(error instanceof Error ? error.message : 'Sync failed.', 'error')
      setCurrentTask('Sync failed.')
      setSyncing(false)
    }
  }

  const stats = React.useMemo(() => {
    const needsSync = documents.filter(documentNeedsSync)
    const neverSynced = documents.filter((document) =>
      document.locales.some((locale) => locale.status === 'never-synced'),
    )
    return {
      needsSync: needsSync.length,
      neverSynced: neverSynced.length,
      synced: documents.length - needsSync.length,
      total: documents.length,
    }
  }, [documents])

  const visibleDocuments = React.useMemo(() => {
    const query = search.trim().toLocaleLowerCase()

    return documents
      .filter((document) => {
        if (filter === 'needs-sync') {
          return documentNeedsSync(document)
        }
        if (filter === 'synced') {
          return !documentNeedsSync(document)
        }
        return true
      })
      .filter(
        (document) =>
          !query ||
          document.label.toLocaleLowerCase().includes(query) ||
          (document.collection ?? document.global ?? '').toLocaleLowerCase().includes(query),
      )
      .sort((left, right) => {
        const needsLeft = documentNeedsSync(left) ? 1 : 0
        const needsRight = documentNeedsSync(right) ? 1 : 0
        return (
          needsRight - needsLeft ||
          right.maxChangedFields - left.maxChangedFields ||
          left.label.localeCompare(right.label)
        )
      })
  }, [documents, filter, search])

  const selectableVisible = React.useMemo(
    () =>
      visibleDocuments.filter(
        (document) => Boolean(document.collection) && document.id != null && documentNeedsSync(document),
      ),
    [visibleDocuments],
  )

  const allVisibleSelected =
    selectableVisible.length > 0 &&
    selectableVisible.every((document) => selectedDocKeys.includes(documentKey(document)))

  const toggleDocument = (key: string) =>
    setSelectedDocKeys((previous) =>
      previous.includes(key) ? previous.filter((entry) => entry !== key) : [...previous, key],
    )

  const toggleAllVisible = () =>
    setSelectedDocKeys(
      allVisibleSelected ? [] : selectableVisible.map((document) => documentKey(document)),
    )

  const statusFilters: Array<{ label: string; value: StatusFilter }> = [
    { label: `Needs sync (${stats.needsSync})`, value: 'needs-sync' },
    { label: `Up to date (${stats.synced})`, value: 'synced' },
    { label: `All (${stats.total})`, value: 'all' },
  ]

  return (
    <ToolPage running={busy}>
      <ToolPanel
        description="See which documents changed in the default locale after their last translation sync — or were never synced at all. Select the documents that need attention and sync them straight from this overview."
        eyebrow="AI translations"
        headerExtra={
          <div className={toolStyles.badgeRow}>
            <Badge>Source: {defaultLocale}</Badge>
            {locales
              .filter((code) => code !== defaultLocale)
              .map((code) => (
                <Badge key={code}>→ {code}</Badge>
              ))}
          </div>
        }
        title="Translation status"
      >
        <CheckboxCardGroup
          disabled={busy}
          label="Targets"
          onToggle={toggleTarget}
          onToggleAll={toggleAllTargets}
          options={allTargets.map((target) => ({
            key: target.key,
            meta: `${target.type}:${target.slug}`,
            title: target.label,
          }))}
          selectedKeys={selectedKeys}
        />

        <div className={toolStyles.actions}>
          <Button disabled={busy || !selectedKeys.length} onClick={() => void startScan()} type="button">
            {scanning ? 'Scanning…' : 'Scan translation status'}
          </Button>
          <Button
            buttonStyle="secondary"
            disabled={busy || !syncableSelection.length}
            onClick={() => void startSync()}
            type="button"
          >
            {syncing
              ? 'Syncing…'
              : `Sync ${syncableSelection.length} document${syncableSelection.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      </ToolPanel>

      {hasScanned ? (
        <ToolPanel>
          <ToolSection>
            <StatGrid
              stats={[
                { label: 'Documents scanned', value: stats.total },
                {
                  label: 'Needs sync',
                  tone: stats.needsSync ? 'warning' : 'success',
                  value: stats.needsSync,
                },
                {
                  label: 'Never synced',
                  tone: stats.neverSynced ? 'error' : 'default',
                  value: stats.neverSynced,
                },
                { label: 'Up to date', tone: 'success', value: stats.synced },
              ]}
            />
          </ToolSection>
          <ToolSection>
            <ProgressSection
              completed={progress.completed}
              status={currentTask}
              total={progress.total}
            />
          </ToolSection>
        </ToolPanel>
      ) : null}

      <ToolPanel title="Documents">
        <div className={styles.toolbar}>
          <input
            aria-label="Search documents"
            className={`${toolStyles.input} ${styles.search}`}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search document or collection…"
            type="search"
            value={search}
          />
          <div className={toolStyles.chipRow} role="group">
            {statusFilters.map((option) => (
              <button
                aria-pressed={filter === option.value}
                className={`${toolStyles.chip} ${filter === option.value ? toolStyles.chipActive : ''}`}
                key={option.value}
                onClick={() => setFilter(option.value)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {!documents.length ? (
          <p className={toolStyles.empty}>
            {hasScanned && !scanning
              ? 'No documents found for the selected targets.'
              : 'Run a scan to see which documents still need a translation sync.'}
          </p>
        ) : !visibleDocuments.length ? (
          <p className={toolStyles.empty}>No documents match the current filters.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.selectCell}>
                    <input
                      aria-label="Select all documents that need a sync"
                      checked={allVisibleSelected}
                      disabled={busy || !selectableVisible.length}
                      onChange={toggleAllVisible}
                      type="checkbox"
                    />
                  </th>
                  <th>Document</th>
                  <th>Locales</th>
                  <th>Fields</th>
                  <th>Last synced</th>
                </tr>
              </thead>
              <tbody>
                {visibleDocuments.map((document) => {
                  const key = documentKey(document)
                  const selectable =
                    Boolean(document.collection) && document.id != null && documentNeedsSync(document)
                  const href = document.global
                    ? `${routes.admin}/globals/${encodeURIComponent(document.global)}`
                    : `${routes.admin}/collections/${encodeURIComponent(
                        document.collection ?? '',
                      )}/${encodeURIComponent(String(document.id))}`
                  const latestSync = document.locales
                    .map((locale) => locale.syncedAt)
                    .filter((value): value is string => Boolean(value))
                    .sort()
                    .at(-1)

                  return (
                    <tr key={key}>
                      <td className={styles.selectCell}>
                        <input
                          aria-label={`Select ${document.label}`}
                          checked={selectedDocKeys.includes(key)}
                          disabled={busy || !selectable}
                          onChange={() => toggleDocument(key)}
                          title={
                            document.global
                              ? 'Globals are synced from their own document view.'
                              : undefined
                          }
                          type="checkbox"
                        />
                      </td>
                      <td>
                        <a className={styles.documentLink} href={href}>
                          {document.label}
                        </a>
                        <div className={styles.documentMeta}>
                          {document.global
                            ? `global:${document.global}`
                            : `${document.collection} · ${String(document.id)}`}
                        </div>
                      </td>
                      <td>
                        <span className={styles.localeBadges}>
                          {document.locales.map((locale) => (
                            <span
                              key={locale.locale}
                              title={`Last synced: ${formatSyncedAt(locale.syncedAt)}`}
                            >
                              <Badge tone={localeBadgeTone(locale.status)}>
                                {localeBadgeText(locale)}
                              </Badge>
                            </span>
                          ))}
                        </span>
                      </td>
                      <td className={styles.fieldCount}>
                        {document.maxChangedFields ? (
                          <>
                            {document.maxChangedFields}/{document.totalFields} changed
                          </>
                        ) : (
                          <span className={styles.muted}>{document.totalFields} fields</span>
                        )}
                      </td>
                      <td>
                        <span className={styles.muted}>{formatSyncedAt(latestSync)}</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </ToolPanel>

      <LogViewer emptyText="Run a scan to see activity here." log={log} />
    </ToolPage>
  )
}
