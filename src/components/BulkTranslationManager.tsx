'use client'

import { Button } from '@payloadcms/ui'
import { useField } from '@payloadcms/ui/dist/forms/useField/index.js'
import * as React from 'react'

import type { BulkStreamEvent } from '../types/bulk.js'

import styles from './BulkTranslationManager.module.css'

type BulkOption = { label: string; value: string }

type FieldProps = {
  description?: string
  label?: string
  name: string
  path: string
  required?: boolean
}

interface BulkTranslationManagerProps extends FieldProps {
  defaultLocale: string
  locales: string[]
  options: BulkOption[]
}

type LogEntry = { level: 'error' | 'info'; message: string; timestamp: number }

type ProgressState = { processed: number; total: number }

type DocumentProgressState = {
  completed: number
  id: string
  locale: string
  total: number
}

type BulkSummary = { failed: number; processed: number; skipped: number }

export function BulkTranslationManager(props: BulkTranslationManagerProps) {
  const { name, description, label, options } = props
  const field = useField<string[]>({ path: props.path })
  const selected = React.useMemo(
    () => (Array.isArray(field.value) ? field.value.filter((value) => typeof value === 'string') : []),
    [field.value],
  )
  const optionLabelByValue = React.useMemo(
    () => Object.fromEntries(options.map((option) => [option.value, option.label])),
    [options],
  )

  const [busy, setBusy] = React.useState(false)
  const [progress, setProgress] = React.useState<ProgressState>({ processed: 0, total: 0 })
  const [documentProgress, setDocumentProgress] = React.useState<DocumentProgressState | null>(null)
  const [activeCollection, setActiveCollection] = React.useState<null | string>(null)
  const [activeDocument, setActiveDocument] = React.useState<null | string>(null)
  const [logs, setLogs] = React.useState<LogEntry[]>([])
  const [summary, setSummary] = React.useState<BulkSummary | null>(null)
  const [errorMessage, setErrorMessage] = React.useState<null | string>(null)

  const appendLog = React.useCallback((entry: LogEntry) => {
    setLogs((previous) => {
      const next = [...previous, entry]
      if (next.length > 150) {
        return next.slice(next.length - 150)
      }
      return next
    })
  }, [])

  const handleToggle = React.useCallback(
    (value: string) => {
      setErrorMessage(null)
      const next = new Set(selected)
      if (next.has(value)) {
        next.delete(value)
      } else {
        next.add(value)
      }
      field.setValue(Array.from(next))
    },
    [field, selected],
  )

  const handleBulkEvent = React.useCallback(
    (event: BulkStreamEvent) => {
      switch (event.type) {
        case 'collection-complete':
          setActiveCollection(null)
          break
        case 'collection-start':
          setActiveCollection(event.collection)
          break
        case 'document-error':
          setDocumentProgress(null)
          break
        case 'document-progress':
          setDocumentProgress({
            id: event.id,
            completed: event.completed,
            locale: event.locale,
            total: event.total,
          })
          break
        case 'document-skipped':
          setDocumentProgress(null)
          break
        case 'document-start':
          setActiveDocument(event.id)
          setDocumentProgress(null)
          break
        case 'document-success':
          setDocumentProgress(null)
          break
        case 'done':
          setSummary({ failed: event.failed, processed: event.processed, skipped: event.skipped })
          setActiveCollection(null)
          setActiveDocument(null)
          setDocumentProgress(null)
          break
        case 'log':
          appendLog({ level: event.level, message: event.message, timestamp: Date.now() })
          break
        case 'overall-progress':
          setProgress({ processed: event.processed, total: event.total })
          break
        case 'start':
          setProgress({ processed: 0, total: event.totalDocuments })
          setSummary(null)
          break
        default:
          break
      }
    },
    [appendLog],
  )

  const handleStart = React.useCallback(async () => {
    if (!selected.length) {
      setErrorMessage('Select at least one collection before starting a bulk translation.')
      return
    }

    try {
      setBusy(true)
      setErrorMessage(null)
      setLogs([])
      setSummary(null)
      setActiveCollection(null)
      setActiveDocument(null)
      setDocumentProgress(null)
      setProgress({ processed: 0, total: 0 })

      const response = await fetch('/api/ai-translate/bulk', {
        body: JSON.stringify({ collections: selected }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      if (!response.ok) {
        const text = await response.text().catch(() => 'Bulk translation failed.')
        const message = text || 'Bulk translation failed.'
        setErrorMessage(message)
        appendLog({ level: 'error', message, timestamp: Date.now() })
        setBusy(false)
        return
      }

      if (!response.body) {
        const message = 'The server did not return any progress updates.'
        setErrorMessage(message)
        appendLog({ level: 'error', message, timestamp: Date.now() })
        setBusy(false)
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let complete = false

      while (!complete) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }

        buffer += decoder.decode(value, { stream: true })
        let newlineIndex = buffer.indexOf('\n')
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim()
          buffer = buffer.slice(newlineIndex + 1)

          if (line) {
            try {
              const parsed = JSON.parse(line) as BulkStreamEvent
              handleBulkEvent(parsed)
              if (parsed.type === 'done') {
                complete = true
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Failed to parse progress.'
              appendLog({ level: 'error', message, timestamp: Date.now() })
            }
          }

          newlineIndex = buffer.indexOf('\n')
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Bulk translation failed.'
      setErrorMessage(message)
      appendLog({ level: 'error', message, timestamp: Date.now() })
    } finally {
      setBusy(false)
    }
  }, [appendLog, handleBulkEvent, selected])

  const renderLogEntry = (entry: LogEntry) => {
    const className = entry.level === 'error' ? styles.logError : styles.logInfo
    return (
      <li className={`${styles.logEntry} ${className}`} key={`${entry.timestamp}-${entry.message}`}>
        {new Date(entry.timestamp).toLocaleTimeString()} — {entry.message}
      </li>
    )
  }

  const activeCollectionLabel = activeCollection ? optionLabelByValue[activeCollection] ?? activeCollection : null

  const progressText = `${Math.min(progress.processed, progress.total)} / ${progress.total} documents processed`

  return (
    <div className={styles.wrapper} data-field={name}>
      {label ? (
        <label className={styles.label} htmlFor={name}>
          {label}
          {props.required ? ' *' : ''}
        </label>
      ) : null}
      {description ? <p className={styles.description}>{description}</p> : null}
      <div className={styles.checkboxList} id={name}>
        {options.length ? (
          options.map((option) => {
            const checked = selected.includes(option.value)
            const optionId = `bulk-collection-${option.value}`
            return (
              <label className={styles.checkboxOption} htmlFor={optionId} key={option.value}>
                <input
                  aria-label={option.label}
                  checked={checked}
                  disabled={busy}
                  id={optionId}
                  onChange={() => handleToggle(option.value)}
                  type="checkbox"
                  value={option.value}
                />
                <span>{option.label}</span>
              </label>
            )
          })
        ) : (
          <span className={styles.emptyState}>No collections available for bulk translation.</span>
        )}
      </div>
      {field.showError && field.errorMessage ? (
        <span className={styles.errorMessage}>{field.errorMessage}</span>
      ) : null}
      {errorMessage ? <span className={styles.errorMessage}>{errorMessage}</span> : null}
      <div className={styles.actions}>
        <Button disabled={busy || !selected.length} onClick={handleStart} type="button">
          Start bulk translation
        </Button>
        {busy ? (
          <span className={styles.status}>
            Processing
            {activeCollectionLabel ? ` ${activeCollectionLabel}` : ''}
            {activeDocument ? ` – #${activeDocument}` : ''}
          </span>
        ) : null}
      </div>
      <div className={styles.progressContainer}>
        <progress
          aria-label="Bulk translation progress"
          aria-valuemax={progress.total || 1}
          aria-valuenow={Math.min(progress.processed, progress.total || 1)}
          className={styles.progressBar}
          max={Math.max(progress.total, 1)}
          value={Math.min(progress.processed, progress.total || 1)}
        />
        <span className={styles.status}>{progressText}</span>
        {documentProgress ? (
          <span className={styles.localeProgress}>
            Locale {documentProgress.locale}: {documentProgress.completed} / {documentProgress.total}
          </span>
        ) : null}
      </div>
      {summary ? (
        <div className={styles.summary}>
          Summary — {summary.processed} translated, {summary.failed} failed, {summary.skipped} skipped.
        </div>
      ) : null}
      <div className={styles.logContainer}>
        <h4 className={styles.logTitle}>Activity log</h4>
        <ul className={styles.logList}>{logs.map(renderLogEntry)}</ul>
      </div>
    </div>
  )
}
