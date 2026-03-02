'use client'

import { Button } from '@payloadcms/ui'
import * as React from 'react'

import type { BulkGrammarApplyTarget, BulkStreamEvent } from '../../server/translationTypes.js'

import { stripLexicalMarkers } from '../../utils/lexical.js'
import styles from '../bulk-translate/BulkTranslate.module.css'
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

type LogStatus = 'error' | 'info' | 'skip' | 'success'
type LogEntry = { id: number; message: string; status: LogStatus; timestamp: number }
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

const MAX_LOGS = 500

function normalizeDocumentId(rawId: string): number | string {
  if (/^-?\d+$/.test(rawId)) {
    const asNumber = Number(rawId)
    if (Number.isSafeInteger(asNumber) && String(asNumber) === rawId) {
      return asNumber
    }
  }

  return rawId
}

function normalizePreviewText(value: string): string {
  return stripLexicalMarkers(value).replace(/\s+/g, ' ').trim()
}

function trimSnippet(value: string, start: number, end: number, radius = 42): string {
  const safeEnd = Math.max(end, start + 1)
  const left = Math.max(0, start - radius)
  const right = Math.min(value.length, safeEnd + radius)

  let snippet = value.slice(left, right).trim()
  if (!snippet) {
    snippet = value.trim()
  }

  if (left > 0) {
    snippet = `...${snippet}`
  }

  if (right < value.length) {
    snippet = `${snippet}...`
  }

  return snippet
}

function getChangedSnippet(before: string, after: string): { after: string; before: string } {
  const normalizedBefore = normalizePreviewText(before)
  const normalizedAfter = normalizePreviewText(after)

  if (!normalizedBefore && !normalizedAfter) {
    return { after: '', before: '' }
  }

  if (normalizedBefore === normalizedAfter) {
    const fallback = trimSnippet(normalizedBefore, 0, Math.min(normalizedBefore.length, 24), 24)
    return { after: fallback, before: fallback }
  }

  let start = 0
  const maxPrefix = Math.min(normalizedBefore.length, normalizedAfter.length)
  while (start < maxPrefix && normalizedBefore[start] === normalizedAfter[start]) {
    start += 1
  }

  let beforeEnd = normalizedBefore.length - 1
  let afterEnd = normalizedAfter.length - 1

  while (
    beforeEnd >= start &&
    afterEnd >= start &&
    normalizedBefore[beforeEnd] === normalizedAfter[afterEnd]
  ) {
    beforeEnd -= 1
    afterEnd -= 1
  }

  return {
    after: trimSnippet(normalizedAfter, start, afterEnd + 1),
    before: trimSnippet(normalizedBefore, start, beforeEnd + 1),
  }
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

export function GrammarCheckGlobal({ collections, defaultLocale, globals = [] }: GrammarCheckGlobalProps) {
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

  const [selectedKeys, setSelectedKeys] = React.useState<string[]>(() => allTargets.map((t) => t.key))
  const [running, setRunning] = React.useState(false)
  const [progress, setProgress] = React.useState<ProgressState>({ completed: 0, total: 0 })
  const [stats, setStats] = React.useState<StatState>({ failed: 0, processed: 0, skipped: 0 })
  const [logs, setLogs] = React.useState<LogEntry[]>([])
  const [currentTask, setCurrentTask] = React.useState('Idle')
  const [logFilter, setLogFilter] = React.useState<'all' | LogStatus>('all')
  const [scanCompleted, setScanCompleted] = React.useState(false)
  const [scanDocuments, setScanDocuments] = React.useState<ScanDocument[]>([])
  const [scanSignature, setScanSignature] = React.useState<null | string>(null)
  const logCounter = React.useRef(0)

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

  React.useEffect(() => {
    setScanCompleted(false)
    setScanDocuments([])
    setScanSignature(null)
  }, [selectionSignature])

  const toggleTarget = (key: string) => {
    setSelectedKeys((previous) =>
      previous.includes(key) ? previous.filter((entry) => entry !== key) : [...previous, key],
    )
  }

  const addLog = (message: string, status: LogStatus = 'info') => {
    setLogs((previous) => {
      logCounter.current += 1
      const entry: LogEntry = {
        id: logCounter.current,
        message,
        status,
        timestamp: Date.now(),
      }
      const next = [...previous, entry]
      return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next
    })
  }

  const clearLogs = () => setLogs([])

  const copyLogs = async () => {
    const text = visibleLogs(logs, logFilter)
      .map((l) => `[${formatTime(l.timestamp)}] ${l.status.toUpperCase()}: ${l.message}`)
      .join('\n')

    try {
      await navigator.clipboard.writeText(text || 'No log entries.')
    } catch {
      // ignore clipboard failures
    }
  }

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
        addLog(
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
        addLog(
          `Starting grammar ${mode} for ${event.totalCollections} target(s) / ${event.totalDocuments} document(s).`,
        )
        setCurrentTask('Preparing…')
        break
      case 'collection-complete':
        addLog(
          `Finished ${event.collection}: ${event.processed} processed, ${event.skipped} skipped, ${event.failed} failed.`,
        )
        setCurrentTask('Next target…')
        break
      case 'collection-start':
        addLog(`Processing ${event.label} (${event.collection}) with ${event.totalDocuments} document(s).`)
        setCurrentTask(`Target ${event.collection}…`)
        break
      case 'document-applied':
        addLog(`Applied typo fixes for ${formatTarget(event.collection, event.id)} (${event.locale}).`, 'success')
        break
      case 'document-error':
        addLog(`Failed ${formatTarget(event.collection, event.id)}: ${event.message}.`, 'error')
        incrementProgress()
        setStats((previous) => ({ ...previous, failed: previous.failed + 1 }))
        break
      case 'document-fixes': {
        const targetLabel = event.global ? `global:${event.global}` : formatTarget(event.collection, event.id)
        addLog(`Found ${event.fixes.length} typo(s) in ${targetLabel}.`, 'info')

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
        addLog(
          `Skipped ${formatTarget(event.collection, event.id)}: ${event.reason || 'No action required.'}`,
          'skip',
        )
        incrementProgress()
        setStats((previous) => ({ ...previous, skipped: previous.skipped + 1 }))
        break
      case 'document-start':
        addLog(`Checking ${formatTarget(event.collection, event.id)}.`)
        setCurrentTask(`Checking ${formatTarget(event.collection, event.id)}…`)
        break
      case 'document-success':
        addLog(
          mode === 'scan'
            ? `Corrections detected for ${formatTarget(event.collection, event.id)}.`
            : `Completed ${formatTarget(event.collection, event.id)}.`,
          'success',
        )
        incrementProgress()
        setStats((previous) => ({ ...previous, processed: previous.processed + 1 }))
        break
      case 'error':
        addLog(event.message || 'Grammar check failed.', 'error')
        setCurrentTask('Failed.')
        setRunning(false)
        break
    }
  }

  const run = async (mode: RunMode) => {
    const selectedCount = selectedCollections.length + selectedGlobals.length
    const isApply = mode === 'apply'
    const canRun =
      selectedCount > 0 &&
      !running &&
      (!isApply || (scanCompleted && scanSignature === selectionSignature && applyTargets.length > 0))

    if (!canRun) {
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
    setLogs([])
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
      addLog(error instanceof Error ? error.message : 'Grammar check failed.', 'error')
      setCurrentTask('Failed.')
      setRunning(false)
    }
  }

  const percentage = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0
  const counts = React.useMemo(() => {
    let e = 0
    let i = 0
    let s = 0
    let w = 0

    for (const log of logs) {
      if (log.status === 'error') {
        e += 1
      } else if (log.status === 'skip') {
        w += 1
      } else if (log.status === 'success') {
        s += 1
      } else {
        i += 1
      }
    }

    return { all: logs.length, e, i, s, w }
  }, [logs])

  const filtered = visibleLogs(logs, logFilter)
  const hasLogs = logs.length > 0
  const selectedCount = selectedCollections.length + selectedGlobals.length
  const canScan = selectedCount > 0 && !running
  const canApply =
    selectedCount > 0 &&
    !running &&
    scanCompleted &&
    scanSignature === selectionSignature &&
    applyTargets.length > 0

  return (
    <div aria-busy={running} className={styles.wrapper}>
      <header className={styles.header}>
        <div className={styles.toprow}>
          <h3 className={styles.summary}>
            Grammar Check ({defaultLocale}) · Scan for typos and apply reviewed fixes.
          </h3>
          <div aria-label="run stats" className={styles.quickStats}>
            <span>
              Processed <strong>{stats.processed}</strong>
            </span>
            <span>
              Skipped <strong>{stats.skipped}</strong>
            </span>
            <span>
              Failed <strong>{stats.failed}</strong>
            </span>
          </div>
        </div>

        <div className={styles.controls}>
          <div className={styles.collections}>
            <ul aria-label="Targets" className={styles.list} role="group">
              {allTargets.map((target) => {
                const checked = selectedKeys.includes(target.key)
                return (
                  <li key={target.key}>
                    <label className={styles.item}>
                      <input
                        aria-label={`Select ${target.label}`}
                        checked={checked}
                        onChange={() => toggleTarget(target.key)}
                        type="checkbox"
                      />
                      <span className={styles.itemText}>
                        {target.label}{' '}
                        <code className={styles.slug}>
                          {target.type}:{target.slug}
                        </code>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          </div>

          <div className={styles.actions}>
            <Button disabled={!canScan} onClick={() => void run('scan')} type="button">
              {running ? 'Running…' : 'Run typo scan'}
            </Button>
            <Button disabled={!canApply} onClick={() => void run('apply')} type="button">
              Apply all fixes ({applyTargets.length} docs)
            </Button>
            <Button disabled={!hasLogs} onClick={clearLogs} type="button">
              Clear logs
            </Button>
            <Button disabled={!hasLogs} onClick={copyLogs} type="button">
              Copy logs
            </Button>
          </div>
        </div>
      </header>

      <section className={styles.progressArea}>
        <meter
          className={styles.meter}
          max={Math.max(1, progress.total)}
          min={0}
          value={progress.completed}
        />
        <div className={styles.progressRow}>
          <span className={styles.progressMeta}>
            {progress.completed}/{progress.total || '-'} ({percentage}%)
          </span>
          <span aria-live="polite" className={styles.currentTask}>
            {currentTask}
          </span>
        </div>
      </section>

      <details className={styles.log} data-has-logs={scanCompleted || running} open={scanCompleted}>
        <summary className={styles.logSummary}>
          Scan Overview ({scanDocuments.length} docs, {totalFixes} fixes)
        </summary>

        {scanDocuments.length ? (
          <ul className={styles.logList}>
            {scanDocuments.map((entry) => (
              <li className={styles.logItem} key={scanDocumentKey(entry)}>
                <details>
                  <summary>
                    <strong>{formatScanDocumentLabel(entry)}</strong> · {entry.fixes.length} typo(s)
                  </summary>
                  <div>
                    <table style={{ marginTop: '0.5rem', width: '100%' }}>
                      <thead>
                        <tr>
                          <th align="left">Path</th>
                          <th align="left">Before</th>
                          <th align="left">After</th>
                        </tr>
                      </thead>
                      <tbody>
                        {entry.fixes.map((fix, index) => (
                          <FixRow
                            entryId={scanDocumentKey(entry)}
                            fix={fix}
                            index={index}
                            key={`${scanDocumentKey(entry)}-${fix.path}-${index}`}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <ul className={styles.logList}>
            <li className={`${styles.logItem} ${styles.logEmpty}`}>
              Run a scan to list typo suggestions before applying.
            </li>
          </ul>
        )}
      </details>

      <details className={styles.log} data-has-logs={Boolean(logs.length)}>
        <summary className={styles.logSummary}>
          Logs ({counts.all}){counts.e ? ` · ${counts.e} errors` : ''}
          <span className={styles.inlineControls}>
            <label className={styles.selectWrap}>
              <span className="sr-only">Filter</span>
              <select
                className={styles.select}
                onChange={(event) => {
                  const next = event.target.value
                  if (
                    next === 'all' ||
                    next === 'error' ||
                    next === 'info' ||
                    next === 'skip' ||
                    next === 'success'
                  ) {
                    setLogFilter(next)
                  }
                }}
                value={logFilter}
              >
                <option value="all">All</option>
                <option value="error">Errors</option>
                <option value="success">Success</option>
                <option value="skip">Warnings</option>
                <option value="info">Info</option>
              </select>
            </label>
          </span>
        </summary>

        <ul aria-live="polite" className={styles.logList}>
          {filtered.length ? (
            filtered.map((l) => (
              <li className={`${styles.logItem} ${styles['log-' + l.status]}`} key={l.id}>
                <span className={styles.logTime}>[{formatTime(l.timestamp)}]</span>
                <span className={styles.logMessage}>{l.message}</span>
              </li>
            ))
          ) : (
            <li className={`${styles.logItem} ${styles.logEmpty}`}>No log entries.</li>
          )}
        </ul>
      </details>
    </div>
  )
}

function visibleLogs(logs: LogEntry[], filter: 'all' | LogStatus, cap = 200) {
  const arr = filter === 'all' ? logs : logs.filter((l) => l.status === filter)
  return arr.slice(-cap)
}

function formatTime(ts: number) {
  try {
    const d = new Date(ts)
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  } catch {
    return '--:--:--'
  }
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function FixRow(props: {
  entryId: string
  fix: ScanFix
  index: number
}) {
  const snippet = getChangedSnippet(props.fix.before, props.fix.after)

  return (
    <tr key={`${props.entryId}-${props.fix.path}-${props.index}`}>
      <td>
        <code>{props.fix.path}</code>
      </td>
      <td>{snippet.before}</td>
      <td>{snippet.after}</td>
    </tr>
  )
}
