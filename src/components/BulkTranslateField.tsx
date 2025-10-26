'use client'

import { Button } from '@payloadcms/ui'
import * as React from 'react'

import type {
  BulkTranslateLogLevel,
  BulkTranslateStreamEvent,
} from '../server/types.js'

import styles from './BulkTranslateField.module.css'

type LogEntry = {
  id: string
  level: BulkTranslateLogLevel
  message: string
}

type ProgressState = {
  completed: number
  total: number
}

const INITIAL_PROGRESS: ProgressState = { completed: 0, total: 0 }

function logClassName(level: BulkTranslateLogLevel): string {
  switch (level) {
    case 'error':
      return `${styles.logEntry} ${styles.logEntryError}`
    case 'info':
      return `${styles.logEntry} ${styles.logEntryInfo}`
    case 'success':
      return `${styles.logEntry} ${styles.logEntrySuccess}`
    case 'warning':
      return `${styles.logEntry} ${styles.logEntryWarning}`
    default:
      return `${styles.logEntry} ${styles.logEntryInfo}`
  }
}

export function BulkTranslateRunnerField() {
  const [logs, setLogs] = React.useState<LogEntry[]>([])
  const [progress, setProgress] = React.useState<ProgressState>(INITIAL_PROGRESS)
  const [status, setStatus] = React.useState('Idle')
  const [running, setRunning] = React.useState(false)
  const logIdRef = React.useRef(0)
  const abortControllerRef = React.useRef<AbortController | null>(null)
  const stopRequestedRef = React.useRef(false)

  const appendLog = React.useCallback((level: BulkTranslateLogLevel, message: string) => {
    logIdRef.current += 1
    const entry: LogEntry = {
      id: `${logIdRef.current}`,
      level,
      message,
    }
    setLogs((previous) => [...previous, entry])
  }, [])

  const resetState = React.useCallback(() => {
    setLogs([])
    setProgress(INITIAL_PROGRESS)
    setStatus('Idle')
    stopRequestedRef.current = false
  }, [])

  const processEvent = React.useCallback(
    (value: unknown) => {
      if (!value || typeof value !== 'object') {
        appendLog('error', 'Received malformed event from server.')
        return
      }

      const type = (value as { type?: unknown }).type
      if (type !== 'log' && type !== 'progress' && type !== 'error' && type !== 'done') {
        appendLog('error', 'Received malformed event from server.')
        return
      }

      const event = value as BulkTranslateStreamEvent

      switch (event.type) {
        case 'done':
          appendLog('success', 'Bulk translation finished.')
          setStatus('Completed')
          stopRequestedRef.current = true
          break
        case 'error':
          appendLog('error', event.message)
          setStatus('Failed')
          stopRequestedRef.current = true
          break
        case 'log':
          appendLog(event.level, event.message)
          break
        case 'progress':
          setProgress({ completed: event.completed, total: event.total })
          break
        default:
          break
      }
    },
    [appendLog],
  )

  const readStream = React.useCallback(
    async (response: Response) => {
      if (!response.body) {
        appendLog('error', 'Server did not return any data.')
        setStatus('Failed')
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (!stopRequestedRef.current) {
        const { done, value } = await reader.read()
        if (done) {
          const trimmed = buffer.trim()
          if (trimmed) {
            try {
              const parsed = JSON.parse(trimmed)
              processEvent(parsed)
            } catch (_error) {
              appendLog('error', 'Received malformed event from server.')
            }
          }
          break
        }

        buffer += decoder.decode(value, { stream: true })

        let newlineIndex = buffer.indexOf('\n')
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim()
          buffer = buffer.slice(newlineIndex + 1)

          if (line) {
            try {
              const parsed = JSON.parse(line)
              processEvent(parsed)
            } catch (_error) {
              appendLog('error', 'Received malformed event from server.')
            }
          }

          if (stopRequestedRef.current) {
            break
          }

          newlineIndex = buffer.indexOf('\n')
        }
      }

      if (stopRequestedRef.current) {
        try {
          await reader.cancel()
        } catch (_) {
          // ignore cancellation errors
        }
      }
    },
    [appendLog, processEvent],
  )

  const handleRun = React.useCallback(async () => {
    if (running) {
      return
    }

    resetState()
    setRunning(true)
    setStatus('Starting…')

    const controller = new AbortController()
    abortControllerRef.current = controller

    try {
      const response = await fetch('/api/ai-translate/bulk', {
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        signal: controller.signal,
      })

      if (!response.ok) {
        const message = await response.text().catch(() => '')
        appendLog(
          'error',
          message || `Bulk translation request failed with ${response.status} ${response.statusText}.`,
        )
        setStatus('Failed')
        return
      }

      setStatus('Running…')
      await readStream(response)
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        appendLog('warning', 'Bulk translation cancelled.')
        setStatus('Cancelled')
      } else {
        appendLog('error', error instanceof Error ? error.message : 'Bulk translation failed.')
        setStatus('Failed')
      }
    } finally {
      abortControllerRef.current = null
      setRunning(false)
    }
  }, [appendLog, readStream, resetState, running])

  const handleCancel = React.useCallback(() => {
    if (!abortControllerRef.current) {
      return
    }

    stopRequestedRef.current = true
    abortControllerRef.current.abort()
  }, [])

  const percentage = React.useMemo(() => {
    if (!progress.total) {
      return 0
    }

    return Math.min(100, Math.round((progress.completed / progress.total) * 100))
  }, [progress.completed, progress.total])

  return (
    <div className={styles.container}>
      <div className={styles.actions}>
        <Button disabled={running} onClick={handleRun} type="button">
          Run bulk translation
        </Button>
        {running ? (
          <Button appearance="secondary" onClick={handleCancel} type="button">
            Cancel
          </Button>
        ) : null}
        <span className={styles.statusLine}>{status}</span>
      </div>
      <div className={styles.progress}>
        <div className={styles.progressFill} style={{ width: `${percentage}%` }} />
      </div>
      <div className={styles.logList}>
        {logs.length ? (
          logs.map((log) => (
            <div className={logClassName(log.level)} key={log.id}>
              {log.message}
            </div>
          ))
        ) : (
          <div className={styles.logEntryInfo}>No log entries yet.</div>
        )}
      </div>
    </div>
  )
}
