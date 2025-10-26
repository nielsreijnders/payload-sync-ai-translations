// BulkTranslateGlobal.tsx
'use client'

import { Button } from '@payloadcms/ui'
import * as React from 'react'

import type { BulkStreamEvent } from '../../server/types.js'

import styles from './BulkTranslate.module.css'
import { runBulkTranslation } from './utils/runBulkTranslation.js'

type BulkCollectionOption = { label: string; slug: string }
type BulkTranslateGlobalProps = {
  collections: BulkCollectionOption[]
  defaultLocale: string
  locales: string[]
}

type LogStatus = 'error' | 'info' | 'skip' | 'success'
type LogEntry = { id: number; message: string; status: LogStatus; timestamp: number }
type ProgressState = { completed: number; total: number }
type StatState = { failed: number; processed: number; skipped: number }

const MAX_LOGS = 500

export function BulkTranslateGlobal({
  collections,
  defaultLocale,
  locales,
}: BulkTranslateGlobalProps) {
  const [selected, setSelected] = React.useState<string[]>(() => collections.map((c) => c.slug))
  const [running, setRunning] = React.useState(false)
  const [progress, setProgress] = React.useState<ProgressState>({ completed: 0, total: 0 })
  const [stats, setStats] = React.useState<StatState>({ failed: 0, processed: 0, skipped: 0 })
  const [logs, setLogs] = React.useState<LogEntry[]>([])
  const [currentTask, setCurrentTask] = React.useState('Idle')
  const [logFilter, setLogFilter] = React.useState<'all' | LogStatus>('all')
  const logCounter = React.useRef(0)

  React.useEffect(() => {
    setSelected((prev) => {
      const allowed = new Set(collections.map((c) => c.slug))
      const filtered = prev.filter((slug) => allowed.has(slug))
      return filtered.length ? filtered : collections.map((c) => c.slug)
    })
  }, [collections])

  const targets = React.useMemo(
    () => locales.filter((l) => l !== defaultLocale),
    [locales, defaultLocale],
  )

  const localeSummary = React.useMemo(() => {
    return targets.length
      ? `Translating ${defaultLocale} → ${targets.join(', ')}`
      : 'No target locales configured.'
  }, [defaultLocale, targets])

  const toggleCollection = (slug: string) =>
    setSelected((prev) => (prev.includes(slug) ? prev.filter((v) => v !== slug) : [...prev, slug]))

  const toggleAll = () => {
    if (selected.length === collections.length) {
      setSelected([])
    } else {
      setSelected(collections.map((c) => c.slug))
    }
  }

  const addLog = (message: string, status: LogStatus = 'info') => {
    setLogs((prev) => {
      logCounter.current += 1
      const entry: LogEntry = { id: logCounter.current, message, status, timestamp: Date.now() }
      const next = [...prev, entry]
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
      /* noop */
    }
  }

  const incrementProgress = () =>
    setProgress((prev) => ({
      completed: Math.min(prev.total, prev.completed + 1),
      total: prev.total,
    }))

  const handleEvent = (event: BulkStreamEvent) => {
    switch (event.type) {
      case 'bulk-complete':
        addLog(
          `Bulk translation finished. Processed ${event.processed}, skipped ${event.skipped}, failed ${event.failed}.`,
          'success',
        )
        setStats({ failed: event.failed, processed: event.processed, skipped: event.skipped })
        setProgress({
          completed: event.processed + event.skipped + event.failed,
          total: event.processed + event.skipped + event.failed,
        })
        setCurrentTask('Completed.')
        setRunning(false)
        break
      case 'bulk-start':
        setProgress({ completed: 0, total: event.totalDocuments })
        setStats({ failed: 0, processed: 0, skipped: 0 })
        addLog(
          `Starting ${event.totalCollections} collection(s) / ${event.totalDocuments} document(s).`,
        )
        setCurrentTask('Preparing…')
        break
      case 'collection-complete':
        addLog(
          `Finished ${event.collection}: ${event.processed} processed, ${event.skipped} skipped, ${event.failed} failed.`,
        )
        setCurrentTask('Next collection…')
        break
      case 'collection-start':
        addLog(
          `Processing ${event.label} (${event.collection}) with ${event.totalDocuments} document(s).`,
        )
        setCurrentTask(`Collection ${event.collection}…`)
        break
      case 'document-applied':
        addLog(
          `Saved translations for ${event.collection}#${event.id} (${event.locale}).`,
          'success',
        )
        break
      case 'document-error':
        addLog(`Failed ${event.collection}#${event.id}: ${event.message}.`, 'error')
        incrementProgress()
        setStats((p) => ({ ...p, failed: p.failed + 1 }))
        break
      case 'document-progress':
        setCurrentTask(
          `Translating ${event.collection}#${event.id} (${event.locale}) ${event.completed}/${event.total}.`,
        )
        break
      case 'document-skipped':
        addLog(
          `Skipped ${event.collection}#${event.id}: ${event.reason || 'No action required.'}`,
          'skip',
        )
        incrementProgress()
        setStats((p) => ({ ...p, skipped: p.skipped + 1 }))
        break
      case 'document-start':
        addLog(`Translating ${event.collection}#${event.id}.`)
        setCurrentTask(`Translating ${event.collection}#${event.id}…`)
        break
      case 'document-success':
        addLog(`Completed ${event.collection}#${event.id}.`, 'success')
        incrementProgress()
        setStats((p) => ({ ...p, processed: p.processed + 1 }))
        break
      case 'error':
        addLog(event.message || 'Bulk translation failed.', 'error')
        setRunning(false)
        setCurrentTask('Failed.')
        break
    }
  }

  const handleStart = async () => {
    const canStart = selected.length > 0 && !running && targets.length > 0
    if (!canStart) {
      return
    }
    const ok = window.confirm(
      `Start bulk translation for ${selected.length} collection(s)?\n${localeSummary}`,
    )
    if (!ok) {
      return
    }

    setRunning(true)
    setLogs([])
    setStats({ failed: 0, processed: 0, skipped: 0 })
    setProgress({ completed: 0, total: 0 })
    setCurrentTask('Initializing…')

    try {
      await runBulkTranslation(selected, { onEvent: handleEvent })
    } catch (error) {
      addLog(error instanceof Error ? error.message : 'Bulk translation failed.', 'error')
      setCurrentTask('Failed.')
      setRunning(false)
    }
  }

  const percentage = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0
  const counts = React.useMemo(() => {
    let e = 0,
      i = 0,
      s = 0,
      w = 0
    for (const l of logs) {
      if (l.status === 'error') {
        e++
      } else if (l.status === 'skip') {
        w++
      } else if (l.status === 'success') {
        s++
      } else {
        i++
      }
    }
    return { all: logs.length, e, i, s, w }
  }, [logs])

  const filtered = visibleLogs(logs, logFilter)
  const canStart = selected.length > 0 && !running && targets.length > 0
  const hasLogs = logs.length > 0

  return (
    <div aria-busy={running} className={styles.wrapper}>
      <header className={styles.header}>
        <div className={styles.toprow}>
          <h3 className={styles.summary}>{localeSummary}</h3>
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
            {/* <label className={styles.masterLabel}>
              <input
                aria-label="Select all collections"
                checked={selected.length === collections.length && collections.length > 0}
                onChange={toggleAll}
                type="checkbox"
              />
              All collections
              <span className={styles.collectionMeta}>
                ({selected.length}/{collections.length})
              </span>
            </label> */}

            <ul aria-label="Collections" className={styles.list} role="group">
              {collections.map((c) => {
                const checked = selected.includes(c.slug)
                return (
                  <li key={c.slug}>
                    <label className={styles.item}>
                      <input
                        aria-label={`Select ${c.label}`}
                        checked={checked}
                        onChange={() => toggleCollection(c.slug)}
                        type="checkbox"
                      />
                      <span className={styles.itemText}>
                        {c.label} <code className={styles.slug}>{c.slug}</code>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          </div>

          <div className={styles.actions}>
            <Button disabled={!canStart} onClick={handleStart} type="button">
              {running ? 'Running…' : 'Start bulk translation'}
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

      <details className={styles.log} data-has-logs={!!logs.length}>
        <summary className={styles.logSummary}>
          Logs ({counts.all}){counts.e ? ` · ${counts.e} errors` : ''}
          <span className={styles.inlineControls}>
            <label className={styles.selectWrap}>
              <span className="sr-only">Filter</span>
              <select
                className={styles.select}
                onChange={(e) => setLogFilter(e.target.value as any)}
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

/* ---------- helpers ---------- */
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
