'use client'

import { Button } from '@payloadcms/ui'
import * as React from 'react'

import type { BulkStreamEvent } from '../../server/translationTypes.js'

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
import styles from '../shared/ToolUI.module.css'
import { runBulkTranslation } from './utils/runBulkTranslation.js'

type BulkCollectionOption = { label: string; slug: string }
type BulkTranslateGlobalProps = {
  collections: BulkCollectionOption[]
  defaultLocale: string
  locales: string[]
}

type ProgressState = { completed: number; total: number }
type StatState = { failed: number; processed: number; skipped: number }

function parseSkipFields(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,\n;]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  )
}

export function BulkTranslateGlobal({
  collections,
  defaultLocale,
  locales,
}: BulkTranslateGlobalProps) {
  const [selected, setSelected] = React.useState<string[]>(() => collections.map((c) => c.slug))
  const [running, setRunning] = React.useState(false)
  const [progress, setProgress] = React.useState<ProgressState>({ completed: 0, total: 0 })
  const [stats, setStats] = React.useState<StatState>({ failed: 0, processed: 0, skipped: 0 })
  const [currentTask, setCurrentTask] = React.useState('Waiting to start…')
  const [hasRun, setHasRun] = React.useState(false)
  const [overwrite, setOverwrite] = React.useState(false)
  const [skipFieldsText, setSkipFieldsText] = React.useState('')
  const log = useToolLogs()

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

  const skipFields = React.useMemo(() => parseSkipFields(skipFieldsText), [skipFieldsText])

  const toggleCollection = (slug: string) =>
    setSelected((prev) => (prev.includes(slug) ? prev.filter((v) => v !== slug) : [...prev, slug]))

  const toggleAll = () =>
    setSelected((prev) =>
      prev.length === collections.length ? [] : collections.map((c) => c.slug),
    )

  const incrementProgress = () =>
    setProgress((prev) => ({
      completed: Math.min(prev.total, prev.completed + 1),
      total: prev.total,
    }))

  const handleEvent = (event: BulkStreamEvent) => {
    switch (event.type) {
      case 'bulk-complete':
        log.addLog(
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
        log.addLog(
          `Starting ${event.totalCollections} collection(s) / ${event.totalDocuments} document(s).`,
        )
        setCurrentTask('Preparing…')
        break
      case 'collection-complete':
        log.addLog(
          `Finished ${event.collection}: ${event.processed} processed, ${event.skipped} skipped, ${event.failed} failed.`,
        )
        setCurrentTask('Next collection…')
        break
      case 'collection-start':
        log.addLog(
          `Processing ${event.label} (${event.collection}) with ${event.totalDocuments} document(s).`,
        )
        setCurrentTask(`Collection ${event.collection}…`)
        break
      case 'document-applied':
        log.addLog(
          `Saved translations for ${event.collection}#${event.id} (${event.locale}).`,
          'success',
        )
        break
      case 'document-error':
        log.addLog(`Failed ${event.collection}#${event.id}: ${event.message}.`, 'error')
        incrementProgress()
        setStats((p) => ({ ...p, failed: p.failed + 1 }))
        break
      case 'document-progress':
        setCurrentTask(
          `Translating ${event.collection}#${event.id} (${event.locale}) ${event.completed}/${event.total}.`,
        )
        break
      case 'document-skipped':
        log.addLog(
          `Skipped ${event.collection}#${event.id}: ${event.reason || 'No action required.'}`,
          'skip',
        )
        incrementProgress()
        setStats((p) => ({ ...p, skipped: p.skipped + 1 }))
        break
      case 'document-start':
        log.addLog(`Translating ${event.collection}#${event.id}.`)
        setCurrentTask(`Translating ${event.collection}#${event.id}…`)
        break
      case 'document-success':
        log.addLog(`Completed ${event.collection}#${event.id}.`, 'success')
        incrementProgress()
        setStats((p) => ({ ...p, processed: p.processed + 1 }))
        break
      case 'error':
        log.addLog(event.message || 'Bulk translation failed.', 'error')
        setRunning(false)
        setCurrentTask('Failed.')
        break
    }
  }

  const canStart = selected.length > 0 && !running && targets.length > 0

  const handleStart = async () => {
    if (!canStart) {
      return
    }
    const confirmLines = [
      `Start bulk translation for ${selected.length} collection(s)?`,
      `Translating ${defaultLocale} → ${targets.join(', ')}`,
      overwrite ? 'Overwrite existing translations: yes' : 'Overwrite existing translations: no',
      skipFields.length ? `Skip fields: ${skipFields.join(', ')}` : '',
    ].filter(Boolean)

    const ok = window.confirm(confirmLines.join('\n'))
    if (!ok) {
      return
    }

    setRunning(true)
    setHasRun(true)
    log.clearLogs()
    setStats({ failed: 0, processed: 0, skipped: 0 })
    setProgress({ completed: 0, total: 0 })
    setCurrentTask('Initializing…')

    try {
      if (overwrite) {
        log.addLog('Overwrite enabled: existing translations will be replaced.')
      }
      if (skipFields.length) {
        log.addLog(`Skipping fields: ${skipFields.join(', ')}.`)
      }

      await runBulkTranslation(selected, { onEvent: handleEvent, overwrite, skipFields })
    } catch (error) {
      log.addLog(error instanceof Error ? error.message : 'Bulk translation failed.', 'error')
      setCurrentTask('Failed.')
      setRunning(false)
    }
  }

  return (
    <ToolPage running={running}>
      <ToolPanel
        description="Translate every document in the selected collections from the default locale into all other configured locales. Fields that already have a translation are skipped unless overwrite is enabled."
        eyebrow="AI translations"
        headerExtra={
          <div className={styles.badgeRow}>
            {targets.length ? (
              targets.map((target) => (
                <Badge key={target}>
                  {defaultLocale} → {target}
                </Badge>
              ))
            ) : (
              <Badge tone="error">No target locales configured</Badge>
            )}
          </div>
        }
        title="Bulk translation"
      >
        <CheckboxCardGroup
          disabled={running}
          label="Collections"
          onToggle={toggleCollection}
          onToggleAll={toggleAll}
          options={collections.map((c) => ({ key: c.slug, meta: c.slug, title: c.label }))}
          selectedKeys={selected}
        />

        <ToolSection label="Options">
          <label className={styles.checkboxRow}>
            <input
              aria-label="Overwrite existing translations"
              checked={overwrite}
              disabled={running}
              onChange={(event) => setOverwrite(event.target.checked)}
              type="checkbox"
            />
            Overwrite existing translations
          </label>

          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="bulk-translate-skip-fields">
              Skip fields
            </label>
            <textarea
              aria-label="Skip fields"
              className={styles.textarea}
              disabled={running}
              id="bulk-translate-skip-fields"
              onChange={(event) => setSkipFieldsText(event.target.value)}
              placeholder="slug, singularSlug, seo.title"
              rows={2}
              value={skipFieldsText}
            />
            <p className={styles.fieldHint}>
              Field paths to leave untouched, separated by commas or new lines.
            </p>
          </div>
        </ToolSection>

        <div className={styles.actions}>
          <Button disabled={!canStart} onClick={() => void handleStart()} type="button">
            {running ? 'Translating…' : 'Start bulk translation'}
          </Button>
        </div>
      </ToolPanel>

      {hasRun ? (
        <ToolPanel>
          <ToolSection>
            <StatGrid
              stats={[
                { label: 'Processed', tone: 'success', value: stats.processed },
                { label: 'Skipped', tone: stats.skipped ? 'warning' : 'default', value: stats.skipped },
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

      <LogViewer emptyText="Start a bulk translation to see activity here." log={log} />
    </ToolPage>
  )
}
