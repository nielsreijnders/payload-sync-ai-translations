'use client'

import { Button } from '@payloadcms/ui'
import * as React from 'react'

import type { BulkGrammarApplyTarget, BulkStreamEvent } from '../../server/translationTypes.js'

import { getChangedSnippet } from '../shared/diffSnippets.js'
import {
  Badge,
  CheckboxCardGroup,
  EmptyState,
  LogViewer,
  ProgressSection,
  StatGrid,
  ToolPage,
  ToolPanel,
  ToolSection,
  useToolLogs,
} from '../shared/ToolUI.js'
import styles from '../shared/ToolUI.module.css'
import { runBulkGrammarCheck } from './utils/runBulkGrammarCheck.js'

type TargetOption = { label: string; slug: string }
type TargetSelection = {
  key: string
  label: string
  slug: string
  type: 'collection' | 'global'
}

type GrammarCheckGlobalProps = {
  collections: TargetOption[]
  defaultLocale: string
  globals?: TargetOption[]
}

type ProgressState = { completed: number; total: number }
type RunMode = 'apply' | 'scan'
type ScanFix = {
  after: string
  before: string
  lexical: boolean
  path: string
}
type ScanCollectionDocument = {
  collection: string
  fixes: ScanFix[]
  id: string
  kind: 'collection'
}
type ScanGlobalDocument = {
  fixes: ScanFix[]
  global: string
  kind: 'global'
}
type ScanDocument = ScanCollectionDocument | ScanGlobalDocument
type StatState = { failed: number; processed: number; skipped: number }

function normalizeDocumentId(rawId: string): number | string {
  if (/^-?\d+$/.test(rawId)) {
    const asNumber = Number(rawId)
    if (Number.isSafeInteger(asNumber) && String(asNumber) === rawId) {
      return asNumber
    }
  }

  return rawId
}

function scanDocumentKey(doc: ScanDocument): string {
  if (doc.kind === 'global') {
    return `global:${doc.global}`
  }

  return `collection:${doc.collection}#${doc.id}`
}

function formatTarget(collection: string, id: string): string {
  if (collection.startsWith('global:') && collection.slice('global:'.length) === id) {
    return collection
  }

  return `${collection}#${id}`
}

function formatScanDocumentLabel(doc: ScanDocument): string {
  if (doc.kind === 'global') {
    return `global:${doc.global}`
  }

  return `${doc.collection}#${doc.id}`
}

function upsertScanDocument(previous: ScanDocument[], nextEntry: ScanDocument): ScanDocument[] {
  const key = scanDocumentKey(nextEntry)
  const index = previous.findIndex((entry) => scanDocumentKey(entry) === key)

  if (index < 0) {
    return [...previous, nextEntry]
  }

  const next = [...previous]
  next[index] = nextEntry
  return next
}

export function GrammarCheckGlobal({
  collections,
  defaultLocale,
  globals = [],
}: GrammarCheckGlobalProps) {
  const allTargets = React.useMemo<TargetSelection[]>(
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
    allTargets.map((t) => t.key),
  )
  const [running, setRunning] = React.useState(false)
  const [progress, setProgress] = React.useState<ProgressState>({ completed: 0, total: 0 })
  const [stats, setStats] = React.useState<StatState>({ failed: 0, processed: 0, skipped: 0 })
  const [currentTask, setCurrentTask] = React.useState('Waiting to start…')
  const [hasRun, setHasRun] = React.useState(false)
  const [scanCompleted, setScanCompleted] = React.useState(false)
  const [scanDocuments, setScanDocuments] = React.useState<ScanDocument[]>([])
  const [scanSignature, setScanSignature] = React.useState<null | string>(null)
  const log = useToolLogs()

  React.useEffect(() => {
    setSelectedKeys((previous) => {
      const allowed = new Set(allTargets.map((entry) => entry.key))
      const filtered = previous.filter((key) => allowed.has(key))
      return filtered.length ? filtered : allTargets.map((entry) => entry.key)
    })
  }, [allTargets])

  const selectedCollections = React.useMemo(
    () =>
      allTargets
        .filter((target) => selectedKeys.includes(target.key) && target.type === 'collection')
        .map((target) => target.slug),
    [allTargets, selectedKeys],
  )

  const selectedGlobals = React.useMemo(
    () =>
      allTargets
        .filter((target) => selectedKeys.includes(target.key) && target.type === 'global')
        .map((target) => target.slug),
    [allTargets, selectedKeys],
  )

  const selectionSignature = React.useMemo(() => [...selectedKeys].sort().join('|'), [selectedKeys])

  const toggleTarget = (key: string) => {
    setSelectedKeys((previous) =>
      previous.includes(key) ? previous.filter((entry) => entry !== key) : [...previous, key],
    )
  }

  const toggleAll = () =>
    setSelectedKeys((previous) =>
      previous.length === allTargets.length ? [] : allTargets.map((entry) => entry.key),
    )

  const incrementProgress = () =>
    setProgress((previous) => ({
      completed: Math.min(previous.total, previous.completed + 1),
      total: previous.total,
    }))

  const applyTargets = React.useMemo<BulkGrammarApplyTarget[]>(() => {
    const selectedCollectionSet = new Set(selectedCollections)
    const selectedGlobalSet = new Set(selectedGlobals)

    return scanDocuments
      .filter((doc) => {
        if (doc.kind === 'global') {
          return selectedGlobalSet.has(doc.global)
        }

        return selectedCollectionSet.has(doc.collection)
      })
      .map((doc) => {
        const overrides = doc.fixes.map((fix) => ({
          lexical: fix.lexical,
          path: fix.path,
          text: fix.after,
        }))

        if (doc.kind === 'global') {
          return {
            global: doc.global,
            overrides,
          } satisfies BulkGrammarApplyTarget
        }

        return {
          id: normalizeDocumentId(doc.id),
          collection: doc.collection,
          overrides,
        } satisfies BulkGrammarApplyTarget
      })
      .filter((entry) => entry.overrides.length > 0)
  }, [scanDocuments, selectedCollections, selectedGlobals])

  const totalFixes = React.useMemo(
    () => scanDocuments.reduce((total, doc) => total + doc.fixes.length, 0),
    [scanDocuments],
  )
  const selectedFixesCount = React.useMemo(
    () => applyTargets.reduce((total, target) => total + target.overrides.length, 0),
    [applyTargets],
  )

  const handleEvent = (event: BulkStreamEvent, mode: RunMode, runSignature: string) => {
    switch (event.type) {
      case 'bulk-complete': {
        const action = mode === 'scan' ? 'scan' : 'apply'
        log.addLog(
          `Grammar ${action} finished. Processed ${event.processed}, skipped ${event.skipped}, failed ${event.failed}.`,
          'success',
        )
        setStats({ failed: event.failed, processed: event.processed, skipped: event.skipped })
        setProgress({
          completed: event.processed + event.skipped + event.failed,
          total: event.processed + event.skipped + event.failed,
        })
        setCurrentTask('Completed.')
        setRunning(false)
        if (mode === 'scan') {
          setScanCompleted(true)
          setScanSignature(runSignature)
        }
        break
      }
      case 'bulk-start':
        setProgress({ completed: 0, total: event.totalDocuments })
        setStats({ failed: 0, processed: 0, skipped: 0 })
        log.addLog(
          `Starting grammar ${mode} for ${event.totalCollections} target(s) / ${event.totalDocuments} document(s).`,
        )
        setCurrentTask('Preparing…')
        break
      case 'collection-complete':
        log.addLog(
          `Finished ${event.collection}: ${event.processed} processed, ${event.skipped} skipped, ${event.failed} failed.`,
        )
        setCurrentTask('Next target…')
        break
      case 'collection-start':
        log.addLog(
          `Processing ${event.label} (${event.collection}) with ${event.totalDocuments} document(s).`,
        )
        setCurrentTask(`Target ${event.collection}…`)
        break
      case 'document-applied':
        log.addLog(
          `Applied typo fixes for ${formatTarget(event.collection, event.id)} (${event.locale}).`,
          'success',
        )
        break
      case 'document-error':
        log.addLog(`Failed ${formatTarget(event.collection, event.id)}: ${event.message}.`, 'error')
        incrementProgress()
        setStats((previous) => ({ ...previous, failed: previous.failed + 1 }))
        break
      case 'document-fixes': {
        const targetLabel = event.global
          ? `global:${event.global}`
          : formatTarget(event.collection, event.id)
        log.addLog(`Found ${event.fixes.length} typo(s) in ${targetLabel}.`, 'info')

        if (mode === 'scan') {
          setScanDocuments((previous) => {
            const nextEntry: ScanDocument = event.global
              ? {
                  fixes: event.fixes,
                  global: event.global,
                  kind: 'global',
                }
              : {
                  id: event.id,
                  collection: event.collection,
                  fixes: event.fixes,
                  kind: 'collection',
                }

            return upsertScanDocument(previous, nextEntry)
          })
        }

        break
      }
      case 'document-progress':
        setCurrentTask(
          `Applying fixes for ${formatTarget(event.collection, event.id)} (${event.locale}) ${event.completed}/${event.total}.`,
        )
        break
      case 'document-skipped':
        log.addLog(
          `Skipped ${formatTarget(event.collection, event.id)}: ${event.reason || 'No action required.'}`,
          'skip',
        )
        incrementProgress()
        setStats((previous) => ({ ...previous, skipped: previous.skipped + 1 }))
        break
      case 'document-start':
        log.addLog(`Checking ${formatTarget(event.collection, event.id)}.`)
        setCurrentTask(`Checking ${formatTarget(event.collection, event.id)}…`)
        break
      case 'document-success':
        log.addLog(
          mode === 'scan'
            ? `Corrections detected for ${formatTarget(event.collection, event.id)}.`
            : `Completed ${formatTarget(event.collection, event.id)}.`,
          'success',
        )
        incrementProgress()
        setStats((previous) => ({ ...previous, processed: previous.processed + 1 }))
        break
      case 'error':
        log.addLog(event.message || 'Grammar check failed.', 'error')
        setCurrentTask('Failed.')
        setRunning(false)
        break
    }
  }

  const selectedCount = selectedCollections.length + selectedGlobals.length
  const scanIsStale = scanCompleted && scanSignature !== selectionSignature
  const canScan = selectedCount > 0 && !running
  const canApply =
    selectedCount > 0 &&
    !running &&
    scanCompleted &&
    scanSignature === selectionSignature &&
    applyTargets.length > 0

  const run = async (mode: RunMode) => {
    const isApply = mode === 'apply'
    if ((isApply && !canApply) || (!isApply && !canScan)) {
      return
    }

    const summary =
      mode === 'scan'
        ? `Run typo scan for ${selectedCollections.length} collection(s) and ${selectedGlobals.length} global(s) in locale ${defaultLocale}?`
        : `Apply ${selectedFixesCount} typo fix(es) from the current scan in locale ${defaultLocale}?`

    const ok = window.confirm(summary)
    if (!ok) {
      return
    }

    setRunning(true)
    setHasRun(true)
    log.clearLogs()
    setStats({ failed: 0, processed: 0, skipped: 0 })
    setProgress({ completed: 0, total: 0 })
    setCurrentTask('Initializing…')

    if (mode === 'scan') {
      setScanCompleted(false)
      setScanDocuments([])
      setScanSignature(null)
    }

    const runSignature = selectionSignature

    try {
      await runBulkGrammarCheck(
        {
          collections: selectedCollections,
          globals: selectedGlobals,
        },
        {
          apply: isApply,
          applyTargets: isApply ? applyTargets : undefined,
        },
        {
          onEvent(event) {
            handleEvent(event, mode, runSignature)
          },
        },
      )
    } catch (error) {
      log.addLog(error instanceof Error ? error.message : 'Grammar check failed.', 'error')
      setCurrentTask('Failed.')
      setRunning(false)
    }
  }

  return (
    <ToolPage running={running}>
      <ToolPanel
        description="Scan the selected collections and globals for typos and grammar slips in the default locale. Scanning never changes content — review the suggestions below, then apply the fixes."
        eyebrow="AI translations"
        headerExtra={
          <div className={styles.badgeRow}>
            <Badge>Locale: {defaultLocale}</Badge>
          </div>
        }
        title="Grammar check"
      >
        <CheckboxCardGroup
          disabled={running}
          label="Targets"
          onToggle={toggleTarget}
          onToggleAll={toggleAll}
          options={allTargets.map((target) => ({
            key: target.key,
            meta: `${target.type}:${target.slug}`,
            title: target.label,
          }))}
          selectedKeys={selectedKeys}
        />

        <div className={styles.actions}>
          <Button disabled={!canScan} onClick={() => void run('scan')} type="button">
            {running ? 'Running…' : 'Run typo scan'}
          </Button>
          <Button
            buttonStyle="secondary"
            disabled={!canApply}
            onClick={() => void run('apply')}
            type="button"
          >
            Apply {selectedFixesCount} fix{selectedFixesCount === 1 ? '' : 'es'}
          </Button>
        </div>
      </ToolPanel>

      {hasRun ? (
        <ToolPanel>
          <ToolSection>
            <StatGrid
              stats={[
                { label: 'Processed', tone: 'success', value: stats.processed },
                {
                  label: 'Skipped',
                  tone: stats.skipped ? 'warning' : 'default',
                  value: stats.skipped,
                },
                { label: 'Failed', tone: stats.failed ? 'error' : 'default', value: stats.failed },
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

      <ToolPanel
        headerExtra={
          <div className={styles.badgeRow}>
            {scanIsStale ? <Badge tone="warning">Selection changed — run a new scan</Badge> : null}
            <Badge>{scanDocuments.length} documents</Badge>
            <Badge tone={totalFixes ? 'warning' : 'default'}>{totalFixes} suggested fixes</Badge>
          </div>
        }
        title="Scan results"
      >
        {scanDocuments.length ? (
          <ul className={styles.resultList}>
            {scanDocuments.map((entry) => (
              <li key={scanDocumentKey(entry)}>
                <details className={styles.resultItem}>
                  <summary className={styles.resultSummary}>
                    <span className={styles.resultTitle}>{formatScanDocumentLabel(entry)}</span>
                    <Badge tone="warning">
                      {entry.fixes.length} fix{entry.fixes.length === 1 ? '' : 'es'}
                    </Badge>
                  </summary>
                  <div className={styles.resultBody}>
                    <table className={styles.diffTable}>
                      <thead>
                        <tr>
                          <th>Field</th>
                          <th>Before</th>
                          <th>After</th>
                        </tr>
                      </thead>
                      <tbody>
                        {entry.fixes.map((fix, index) => (
                          <FixRow fix={fix} key={`${scanDocumentKey(entry)}-${fix.path}-${index}`} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>
            {scanCompleted
              ? 'The scan found no typos in the selected targets.'
              : 'Run a typo scan to list suggestions here before applying them.'}
          </EmptyState>
        )}
      </ToolPanel>

      <LogViewer emptyText="Run a scan to see activity here." log={log} />
    </ToolPage>
  )
}

function FixRow({ fix }: { fix: ScanFix }) {
  const snippet = getChangedSnippet(fix.before, fix.after)

  return (
    <tr>
      <td className={styles.diffPath}>{fix.path}</td>
      <td className={styles.diffBefore}>{snippet.before}</td>
      <td className={styles.diffAfter}>{snippet.after}</td>
    </tr>
  )
}
