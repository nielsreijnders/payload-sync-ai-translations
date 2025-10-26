'use client'

import { Button } from '@payloadcms/ui'
import * as React from 'react'

import type { BulkStreamEvent } from '../../server/types.js'

import styles from './BulkTranslate.module.css'
import { runBulkTranslation } from './utils/runBulkTranslation.js'

type BulkCollectionOption = {
  label: string
  slug: string
}

type BulkTranslateGlobalProps = {
  collections: BulkCollectionOption[]
  defaultLocale: string
  locales: string[]
}

type LogStatus = 'error' | 'info' | 'skip' | 'success'

type LogEntry = {
  id: number
  message: string
  status: LogStatus
  timestamp: number
}

type ProgressState = {
  completed: number
  total: number
}

type StatState = {
  failed: number
  processed: number
  skipped: number
}

const MAX_LOGS = 200

export function BulkTranslateGlobal(props: BulkTranslateGlobalProps) {
  const { collections, defaultLocale, locales } = props
  const [selected, setSelected] = React.useState<string[]>(() =>
    collections.map((collection) => collection.slug),
  )
  const [running, setRunning] = React.useState(false)
  const [progress, setProgress] = React.useState<ProgressState>({ completed: 0, total: 0 })
  const [stats, setStats] = React.useState<StatState>({ failed: 0, processed: 0, skipped: 0 })
  const [logs, setLogs] = React.useState<LogEntry[]>([])
  const [currentTask, setCurrentTask] = React.useState<string>('Idle')
  const logCounter = React.useRef(0)

  React.useEffect(() => {
    setSelected((previous) => {
      const allowed = new Set(collections.map((collection) => collection.slug))
      const filtered = previous.filter((slug) => allowed.has(slug))
      if (filtered.length) {
        return filtered
      }
      return collections.map((collection) => collection.slug)
    })
  }, [collections])

  const localeSummary = React.useMemo(() => {
    const targets = locales.filter((locale) => locale !== defaultLocale)
    if (!targets.length) {
      return 'No target locales configured.'
    }

    return `Translating from ${defaultLocale} to ${targets.join(', ')}`
  }, [defaultLocale, locales])

  const toggleCollection = React.useCallback((slug: string) => {
    setSelected((previous) => {
      const exists = previous.includes(slug)
      if (exists) {
        return previous.filter((value) => value !== slug)
      }
      return [...previous, slug]
    })
  }, [])

  const selectAll = React.useCallback(() => {
    setSelected(collections.map((collection) => collection.slug))
  }, [collections])

  const clearSelection = React.useCallback(() => {
    setSelected([])
  }, [])

  const addLog = React.useCallback((message: string, status: LogStatus = 'info') => {
    setLogs((previous) => {
      logCounter.current += 1
      const entry: LogEntry = {
        id: logCounter.current,
        message,
        status,
        timestamp: Date.now(),
      }
      const next = [...previous, entry]
      if (next.length > MAX_LOGS) {
        return next.slice(next.length - MAX_LOGS)
      }
      return next
    })
  }, [])

  const incrementProgress = React.useCallback(() => {
    setProgress((previous) => {
      const total = previous.total
      const completed = Math.min(total, previous.completed + 1)
      return { completed, total }
    })
  }, [])

  const handleEvent = React.useCallback(
    (event: BulkStreamEvent) => {
      switch (event.type) {
        case 'bulk-complete':
          addLog(
            `Bulk translation finished. Processed ${event.processed}, skipped ${event.skipped}, failed ${event.failed}.`,
            'success',
          )
          setStats({ failed: event.failed, processed: event.processed, skipped: event.skipped })
          setProgress((previous) => ({
            completed: Math.max(previous.completed, event.processed + event.skipped + event.failed),
            total: previous.total || event.processed + event.skipped + event.failed,
          }))
          setCurrentTask('All tasks completed.')
          setRunning(false)
          break
        case 'bulk-start':
          setProgress({ completed: 0, total: event.totalDocuments })
          setStats({ failed: 0, processed: 0, skipped: 0 })
          addLog(
            `Bulk translation started for ${event.totalCollections} collection(s) with ${event.totalDocuments} document(s).`,
          )
          setCurrentTask('Preparing collections…')
          break
        case 'collection-complete':
          addLog(
            `Finished ${event.collection}: ${event.processed} processed, ${event.skipped} skipped, ${event.failed} failed.`,
          )
          setCurrentTask('Waiting for next collection…')
          break
        case 'collection-start':
          addLog(
            `Processing ${event.label} (${event.collection}) with ${event.totalDocuments} document(s).`,
          )
          setCurrentTask(`Collection ${event.collection} in progress…`)
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
          setStats((previous) => ({
            failed: previous.failed + 1,
            processed: previous.processed,
            skipped: previous.skipped,
          }))
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
          setStats((previous) => ({
            failed: previous.failed,
            processed: previous.processed,
            skipped: previous.skipped + 1,
          }))
          break
        case 'document-start':
          addLog(`Translating ${event.collection}#${event.id}.`)
          setCurrentTask(`Translating ${event.collection}#${event.id}…`)
          break
        case 'document-success':
          addLog(`Completed ${event.collection}#${event.id}.`, 'success')
          incrementProgress()
          setStats((previous) => ({
            failed: previous.failed,
            processed: previous.processed + 1,
            skipped: previous.skipped,
          }))
          break
        case 'error':
          addLog(event.message || 'Bulk translation failed.', 'error')
          setRunning(false)
          setCurrentTask('Bulk translation failed.')
          break
        default:
          break
      }
    },
    [addLog, incrementProgress],
  )

  const handleStart = React.useCallback(async () => {
    if (!selected.length || running) {
      return
    }

    setRunning(true)
    setLogs([])
    setStats({ failed: 0, processed: 0, skipped: 0 })
    setProgress({ completed: 0, total: 0 })
    setCurrentTask('Initializing bulk translation…')

    try {
      await runBulkTranslation(selected, { onEvent: handleEvent })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Bulk translation failed.'
      addLog(message, 'error')
      setCurrentTask('Bulk translation failed.')
      setRunning(false)
    }
  }, [addLog, handleEvent, running, selected])

  const percentage = React.useMemo(() => {
    if (!progress.total) {
      return 0
    }
    return Math.min(100, Math.round((progress.completed / progress.total) * 100))
  }, [progress])

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <h3>Bulk AI Translation</h3>
        <p className={styles.summary}>{localeSummary}</p>
        <p className={styles.currentDocument}>{currentTask}</p>
      </div>

      <div className={styles.selection}>
        {collections.map((collection) => {
          const checked = selected.includes(collection.slug)
          const checkboxId = `bulk-collection-${collection.slug}`
          return (
            <div className={styles.option} key={collection.slug}>
              <input
                aria-labelledby={`${checkboxId}-label`}
                checked={checked}
                className={styles.optionInput}
                disabled={running}
                id={checkboxId}
                onChange={() => toggleCollection(collection.slug)}
                type="checkbox"
              />
              <label className={styles.optionLabel} htmlFor={checkboxId} id={`${checkboxId}-label`}>
                <span>{collection.label}</span>
                <span className={styles.optionSlug}>{collection.slug}</span>
              </label>
            </div>
          )
        })}
      </div>

      <div className={styles.actions}>
        <Button
          disabled={running || selected.length === collections.length}
          onClick={selectAll}
          type="button"
        >
          Select all
        </Button>
        <Button disabled={running || selected.length === 0} onClick={clearSelection} type="button">
          Clear selection
        </Button>
        <Button disabled={running || !selected.length} onClick={handleStart} type="button">
          {running ? 'Running…' : 'Start bulk translation'}
        </Button>
        <div aria-hidden className={styles.progressBar}>
          <div className={styles.progressFill} style={{ width: `${percentage}%` }} />
        </div>
        <span className={styles.progressMeta}>
          {progress.completed}/{progress.total || '-'} documents
        </span>
      </div>

      <div className={styles.status}>
        <span className={styles.statusItem}>Processed: {stats.processed}</span>
        <span className={styles.statusItem}>Skipped: {stats.skipped}</span>
        <span className={styles.statusItem}>Failed: {stats.failed}</span>
        <span className={styles.statusItem}>Selected collections: {selected.length}</span>
      </div>

      <div className={styles.log}>
        <h4>Activity log</h4>
        <ul className={styles.logList}>
          {logs.map((entry) => (
            <li className={`${styles.logItem} ${styles[`log-${entry.status}`]}`} key={entry.id}>
              {entry.message}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
