'use client'

import { Button } from '@payloadcms/ui'
import * as React from 'react'

import type { BulkStreamEvent } from '../../server/translationTypes.js'

import styles from '../bulk-translate/BulkTranslate.module.css'
import { runBulkLinkSync } from './utils/runBulkLinkSync.js'

type BulkCollectionOption = { label: string; slug: string }
type BulkLinkSyncGlobalProps = {
  collections: BulkCollectionOption[]
  defaultLocale: string
  locales: string[]
}

type LogStatus = 'error' | 'info' | 'skip' | 'success'
type LogEntry = { id: number; message: string; status: LogStatus; timestamp: number }

const MAX_LOGS = 200

export function BulkLinkSyncGlobal({
  collections,
  defaultLocale,
  locales,
}: BulkLinkSyncGlobalProps) {
  const [selected, setSelected] = React.useState<string[]>(() => collections.map((c) => c.slug))
  const [running, setRunning] = React.useState(false)
  const [progress, setProgress] = React.useState({ completed: 0, total: 0 })
  const [stats, setStats] = React.useState({ failed: 0, processed: 0, skipped: 0 })
  const [logs, setLogs] = React.useState<LogEntry[]>([])
  const [currentTask, setCurrentTask] = React.useState('Idle')
  const [logFilter, setLogFilter] = React.useState<'all' | LogStatus>('all')
  const counter = React.useRef(0)

  React.useEffect(() => {
    setSelected((prev) => {
      const allowed = new Set(collections.map((c) => c.slug))
      const filtered = prev.filter((slug) => allowed.has(slug))
      return filtered.length ? filtered : collections.map((c) => c.slug)
    })
  }, [collections])

  const targets = React.useMemo(
    () => locales.filter((locale) => locale && locale !== defaultLocale),
    [locales, defaultLocale],
  )

  const localeSummary = React.useMemo(() => {
    return targets.length
      ? `Syncing links for ${defaultLocale} → ${targets.join(', ')}`
      : 'No target locales configured.'
  }, [defaultLocale, targets])

  const toggleCollection = (slug: string) =>
    setSelected((prev) => (prev.includes(slug) ? prev.filter((value) => value !== slug) : [...prev, slug]))

  const addLog = (message: string, status: LogStatus = 'info') => {
    setLogs((prev) => {
      counter.current += 1
      const entry: LogEntry = { id: counter.current, message, status, timestamp: Date.now() }
      const next = [...prev, entry]
      return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next
    })
  }

  const clearLogs = () => setLogs([])
  const copyLogs = async () => {
    const text = visibleLogs(logs, logFilter)
      .map((entry) => `[${formatTime(entry.timestamp)}] ${entry.status.toUpperCase()}: ${entry.message}`)
      .join('\n')
    try {
      await navigator.clipboard.writeText(text || 'No log entries.')
    } catch {
      /* noop */
    }
  }

  const handleEvent = (event: BulkStreamEvent) => {
    switch (event.type) {
      case 'bulk-start':
        setLogs([])
        setProgress({ completed: 0, total: event.totalDocuments })
        setStats({ failed: 0, processed: 0, skipped: 0 })
        setCurrentTask('Preparing…')
        addLog(
          `Starting link synchronization for ${event.totalCollections} collection(s) / ${event.totalDocuments} document(s).`,
        )
        break
      case 'bulk-complete':
        addLog(
          `Link synchronization finished. Processed ${event.processed}, skipped ${event.skipped}, failed ${event.failed}.`,
          'success',
        )
        setStats({ failed: event.failed, processed: event.processed, skipped: event.skipped })
        setProgress({ completed: event.processed + event.skipped + event.failed, total: event.processed + event.skipped + event.failed })
        setCurrentTask('Completed.')
        setRunning(false)
        break
      case 'collection-start':
        addLog(
          `Syncing links for ${event.label} (${event.collection}) with ${event.totalDocuments} document(s).`,
        )
        setCurrentTask(`Collection ${event.collection}…`)
        break
      case 'collection-complete':
        addLog(
          `Finished ${event.collection}: ${event.processed} processed, ${event.skipped} skipped, ${event.failed} failed.`,
        )
        setCurrentTask('Next collection…')
        break
      case 'document-start':
        addLog(`Syncing links for ${event.collection}#${event.id}.`)
        setCurrentTask(`Document ${event.collection}#${event.id}…`)
        break
      case 'document-progress':
        setCurrentTask(
          `Updating ${event.collection}#${event.id} (${event.locale}) ${event.completed}/${event.total}.`,
        )
        break
      case 'document-applied':
        addLog(`Saved link updates for ${event.collection}#${event.id} (${event.locale}).`, 'success')
        break
      case 'document-success':
        addLog(`Completed ${event.collection}#${event.id}.`, 'success')
        setProgress((prev) => ({ ...prev, completed: Math.min(prev.total, prev.completed + 1) }))
        setStats((prev) => ({ ...prev, processed: prev.processed + 1 }))
        break
      case 'document-skipped':
        addLog(
          `Skipped ${event.collection}#${event.id}: ${event.reason || 'No link changes required.'}`,
          'skip',
        )
        setProgress((prev) => ({ ...prev, completed: Math.min(prev.total, prev.completed + 1) }))
        setStats((prev) => ({ ...prev, skipped: prev.skipped + 1 }))
        break
      case 'document-error':
        addLog(`Failed ${event.collection}#${event.id}: ${event.message}.`, 'error')
        setProgress((prev) => ({ ...prev, completed: Math.min(prev.total, prev.completed + 1) }))
        setStats((prev) => ({ ...prev, failed: prev.failed + 1 }))
        break
      case 'error':
        addLog(event.message || 'Bulk link synchronization failed.', 'error')
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
      `Start bulk link synchronization for ${selected.length} collection(s)?\n${localeSummary}`,
    )
    if (!ok) {
      return
    }

    setRunning(true)
    setCurrentTask('Initializing…')

    try {
      await runBulkLinkSync(selected, { onEvent: handleEvent })
    } catch (error) {
      addLog(error instanceof Error ? error.message : 'Bulk link synchronization failed.', 'error')
      setRunning(false)
      setCurrentTask('Failed.')
    }
  }

  const filteredLogs = visibleLogs(logs, logFilter)
  const canStart = selected.length > 0 && !running && targets.length > 0
  const percentage = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0
  const counts = React.useMemo(() => {
    let error = 0
    let info = 0
    let success = 0
    let skip = 0
    for (const entry of logs) {
      if (entry.status === 'error') {
        error += 1
      } else if (entry.status === 'skip') {
        skip += 1
      } else if (entry.status === 'success') {
        success += 1
      } else {
        info += 1
      }
    }
    return { all: logs.length, error, info, skip, success }
  }, [logs])

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
            <ul aria-label="Collections" className={styles.list} role="group">
              {collections.map((collection) => {
                const checked = selected.includes(collection.slug)
                return (
                  <li key={collection.slug}>
                    <label className={styles.item}>
                      <input
                        aria-label={`Select ${collection.label}`}
                        checked={checked}
                        onChange={() => toggleCollection(collection.slug)}
                        type="checkbox"
                      />
                      <span className={styles.itemText}>
                        {collection.label} <code className={styles.slug}>{collection.slug}</code>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          </div>

          <div className={styles.actions}>
            <Button disabled={!canStart} onClick={handleStart} type="button">
              {running ? 'Running…' : 'Start bulk link sync'}
            </Button>
            <Button disabled={!logs.length} onClick={clearLogs} type="button">
              Clear logs
            </Button>
            <Button disabled={!logs.length} onClick={copyLogs} type="button">
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

      <details className={styles.log} data-has-logs={!!logs.length} open={logs.length > 0}>
        <summary className={styles.logSummary}>
          Logs ({counts.all}){counts.error ? ` · ${counts.error} errors` : ''}
          <span className={styles.inlineControls}>
            <label className={styles.selectWrap}>
              <span className="sr-only">Filter</span>
              <select
                className={styles.select}
                onChange={(event) => setLogFilter(event.target.value as typeof logFilter)}
                value={logFilter}
              >
                <option value="all">All</option>
                <option value="error">Errors</option>
                <option value="success">Success</option>
                <option value="skip">Skipped</option>
                <option value="info">Info</option>
              </select>
            </label>
          </span>
        </summary>

        <ul aria-live="polite" className={styles.logList}>
          {filteredLogs.length ? (
            filteredLogs.map((entry) => (
              <li className={`${styles.logItem} ${styles['log-' + entry.status]}`} key={entry.id}>
                <span className={styles.logTime}>[{formatTime(entry.timestamp)}]</span>
                <span className={styles.logMessage}>{entry.message}</span>
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

function visibleLogs(logs: LogEntry[], filter: 'all' | LogStatus): LogEntry[] {
  const entries = filter === 'all' ? logs : logs.filter((entry) => entry.status === filter)
  return entries.slice(-MAX_LOGS)
}

function formatTime(timestamp: number): string {
  try {
    const date = new Date(timestamp)
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  } catch {
    return '--:--:--'
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}
