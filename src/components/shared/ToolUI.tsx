'use client'

import { toast } from '@payloadcms/ui'
import * as React from 'react'

import styles from './ToolUI.module.css'

export type LogStatus = 'error' | 'info' | 'skip' | 'success'
export type LogEntry = { id: number; message: string; status: LogStatus; timestamp: number }
export type LogFilter = 'all' | LogStatus

const MAX_LOGS = 500
const VISIBLE_LOGS = 200

const LOG_STATUS_CLASS: Record<LogStatus, string> = {
  error: styles.logError,
  info: '',
  skip: styles.logSkip,
  success: styles.logSuccess,
}

const LOG_FILTERS: Array<{ label: string; value: LogFilter }> = [
  { label: 'All', value: 'all' },
  { label: 'Errors', value: 'error' },
  { label: 'Success', value: 'success' },
  { label: 'Warnings', value: 'skip' },
  { label: 'Info', value: 'info' },
]

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export type ToolLogApi = {
  addLog: (message: string, status?: LogStatus) => void
  clearLogs: () => void
  counts: Record<LogFilter, number>
  filter: LogFilter
  logs: LogEntry[]
  setFilter: (filter: LogFilter) => void
  visible: LogEntry[]
}

export function useToolLogs(): ToolLogApi {
  const [logs, setLogs] = React.useState<LogEntry[]>([])
  const [filter, setFilter] = React.useState<LogFilter>('all')
  const counter = React.useRef(0)

  const addLog = React.useCallback((message: string, status: LogStatus = 'info') => {
    setLogs((previous) => {
      counter.current += 1
      const entry: LogEntry = { id: counter.current, message, status, timestamp: Date.now() }
      const next = [...previous, entry]
      return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next
    })
  }, [])

  const clearLogs = React.useCallback(() => setLogs([]), [])

  const counts = React.useMemo(() => {
    const next: Record<LogFilter, number> = { all: logs.length, error: 0, info: 0, skip: 0, success: 0 }
    for (const entry of logs) {
      next[entry.status] += 1
    }
    return next
  }, [logs])

  const visible = React.useMemo(() => {
    const matching = filter === 'all' ? logs : logs.filter((entry) => entry.status === filter)
    return matching.slice(-VISIBLE_LOGS)
  }, [filter, logs])

  return { addLog, clearLogs, counts, filter, logs, setFilter, visible }
}

export function ToolPage({ children, running }: { children: React.ReactNode; running?: boolean }) {
  return (
    <div aria-busy={running} className={styles.page}>
      {children}
    </div>
  )
}

export function ToolPanel({
  children,
  description,
  eyebrow,
  headerExtra,
  title,
}: {
  children?: React.ReactNode
  description?: React.ReactNode
  eyebrow?: string
  headerExtra?: React.ReactNode
  title?: string
}) {
  const hasHeader = Boolean(eyebrow || title || description)

  return (
    <section className={styles.panel}>
      {hasHeader ? (
        <div className={styles.panelHeaderRow}>
          <header className={styles.panelHeader}>
            {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
            {title ? <h2 className={styles.title}>{title}</h2> : null}
            {description ? <p className={styles.description}>{description}</p> : null}
          </header>
          {headerExtra ?? null}
        </div>
      ) : null}
      {children}
    </section>
  )
}

export function ToolSection({
  children,
  hint,
  label,
  labelExtra,
}: {
  children: React.ReactNode
  hint?: string
  label?: string
  labelExtra?: React.ReactNode
}) {
  return (
    <div className={styles.section}>
      {label || labelExtra ? (
        <div className={styles.sectionHead}>
          {label ? <h3 className={styles.sectionLabel}>{label}</h3> : null}
          {labelExtra ?? null}
        </div>
      ) : null}
      {children}
      {hint ? <p className={styles.fieldHint}>{hint}</p> : null}
    </div>
  )
}

export type StatTone = 'default' | 'error' | 'success' | 'warning'

const STAT_TONE_CLASS: Record<StatTone, string> = {
  default: '',
  error: styles.statError,
  success: styles.statSuccess,
  warning: styles.statWarning,
}

export function StatGrid({
  stats,
}: {
  stats: Array<{ label: string; tone?: StatTone; value: number | string }>
}) {
  return (
    <div className={styles.statGrid}>
      {stats.map((stat) => (
        <div className={`${styles.stat} ${STAT_TONE_CLASS[stat.tone ?? 'default']}`} key={stat.label}>
          <span className={styles.statLabel}>{stat.label}</span>
          <strong className={styles.statValue}>{stat.value}</strong>
        </div>
      ))}
    </div>
  )
}

export type CheckboxCardOption = {
  key: string
  meta?: string
  title: string
}

export function CheckboxCardGroup({
  disabled,
  label,
  onToggle,
  onToggleAll,
  options,
  selectedKeys,
}: {
  disabled?: boolean
  label: string
  onToggle: (key: string) => void
  onToggleAll?: () => void
  options: CheckboxCardOption[]
  selectedKeys: string[]
}) {
  const allSelected = options.length > 0 && selectedKeys.length === options.length

  return (
    <ToolSection
      label={label}
      labelExtra={
        <span className={styles.sectionHint}>
          {selectedKeys.length} of {options.length} selected
          {onToggleAll && options.length > 1 ? (
            <>
              {' · '}
              <button
                className={styles.textButton}
                disabled={disabled}
                onClick={onToggleAll}
                type="button"
              >
                {allSelected ? 'Deselect all' : 'Select all'}
              </button>
            </>
          ) : null}
        </span>
      }
    >
      <ul aria-label={label} className={styles.cardGrid} role="group">
        {options.map((option) => (
          <li key={option.key}>
            <label className={styles.card}>
              <input
                aria-label={`Select ${option.title}`}
                checked={selectedKeys.includes(option.key)}
                disabled={disabled}
                onChange={() => onToggle(option.key)}
                type="checkbox"
              />
              <span className={styles.cardBody}>
                <span className={styles.cardTitle}>{option.title}</span>
                {option.meta ? <span className={styles.cardMeta}>{option.meta}</span> : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </ToolSection>
  )
}

export function ProgressSection({
  completed,
  status,
  total,
}: {
  completed: number
  status: string
  total: number
}) {
  const percentage = total ? Math.round((completed / total) * 100) : 0
  const indeterminate = total === 0

  return (
    <div className={styles.progress}>
      <div
        aria-label="Progress"
        aria-valuemax={Math.max(1, total)}
        aria-valuemin={0}
        aria-valuenow={indeterminate ? undefined : completed}
        className={styles.progressTrack}
        role="progressbar"
      >
        <span
          className={`${styles.progressFill} ${indeterminate ? styles.progressIndeterminate : ''}`}
          style={indeterminate ? undefined : { width: `${percentage}%` }}
        />
      </div>
      <div className={styles.progressRow}>
        <span aria-live="polite" className={styles.progressStatus}>
          {status}
        </span>
        {!indeterminate ? (
          <span>
            {completed}/{total} ({percentage}%)
          </span>
        ) : null}
      </div>
    </div>
  )
}

export function Badge({
  children,
  tone = 'default',
}: {
  children: React.ReactNode
  tone?: StatTone
}) {
  const toneClass =
    tone === 'success'
      ? styles.badgeSuccess
      : tone === 'warning'
        ? styles.badgeWarning
        : tone === 'error'
          ? styles.badgeError
          : ''

  return <span className={`${styles.badge} ${toneClass}`}>{children}</span>
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className={styles.empty}>{children}</p>
}

export function LogViewer({ emptyText = 'No log entries yet.', log }: { emptyText?: string; log: ToolLogApi }) {
  const listRef = React.useRef<HTMLUListElement>(null)

  React.useEffect(() => {
    const list = listRef.current
    if (list) {
      list.scrollTop = list.scrollHeight
    }
  }, [log.visible])

  const copyLogs = async () => {
    const text = log.visible
      .map((entry) => `[${formatTime(entry.timestamp)}] ${entry.status.toUpperCase()}: ${entry.message}`)
      .join('\n')

    try {
      await navigator.clipboard.writeText(text || 'No log entries.')
      toast.success('Logs copied to clipboard.')
    } catch {
      toast.error('Could not copy logs to clipboard.')
    }
  }

  return (
    <section className={styles.logPanel}>
      <header className={styles.logHeader}>
        <h3 className={styles.logHeaderTitle}>Activity log</h3>
        <div className={styles.logHeaderActions}>
          <div className={styles.chipRow} role="group">
            {LOG_FILTERS.map((option) => (
              <button
                aria-pressed={log.filter === option.value}
                className={`${styles.chip} ${log.filter === option.value ? styles.chipActive : ''}`}
                key={option.value}
                onClick={() => log.setFilter(option.value)}
                type="button"
              >
                {option.label} ({log.counts[option.value]})
              </button>
            ))}
          </div>
          <button
            className={styles.textButton}
            disabled={!log.logs.length}
            onClick={() => void copyLogs()}
            type="button"
          >
            Copy
          </button>
          <button
            className={styles.textButton}
            disabled={!log.logs.length}
            onClick={log.clearLogs}
            type="button"
          >
            Clear
          </button>
        </div>
      </header>
      <ul aria-live="polite" className={styles.logList} ref={listRef}>
        {log.visible.length ? (
          log.visible.map((entry) => (
            <li className={`${styles.logItem} ${LOG_STATUS_CLASS[entry.status]}`} key={entry.id}>
              <span className={styles.logTime}>{formatTime(entry.timestamp)}</span>
              <span className={styles.logMessage}>{entry.message}</span>
            </li>
          ))
        ) : (
          <li className={styles.empty}>{emptyText}</li>
        )}
      </ul>
    </section>
  )
}
