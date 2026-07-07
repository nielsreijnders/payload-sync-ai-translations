'use client'

import { Button, toast, useAuth, useConfig } from '@payloadcms/ui'
import * as React from 'react'

import type { SeoScanDocument, SeoScanEvent, SeoScoreStatus } from '../../server/seoTypes.js'

import { downloadCsv, parseCsv, serializeCsv } from '../shared/csv.js'
import {
  CheckboxCardGroup,
  ProgressSection,
  StatGrid,
  ToolPage,
  ToolPanel,
  ToolSection,
} from '../shared/ToolUI.js'
import toolStyles from '../shared/ToolUI.module.css'
import styles from './SeoOverviewGlobal.module.css'
import { runSeoScan } from './utils/runSeoScan.js'
import { updateSeoMetadata } from './utils/updateSeoMetadata.js'

type CollectionOption = { label: string; slug: string }
type SeoOverviewGlobalProps = {
  collections: CollectionOption[]
  defaultLocale: string
  locales: string[]
}
type ScoreFilter = 'all' | SeoScoreStatus

function statusClass(status: SeoScoreStatus): string {
  if (status === 'good') {
    return styles.good
  }
  if (status === 'needs-work') {
    return styles.needsWork
  }
  return styles.poor
}

function statusLabel(status: SeoScoreStatus): string {
  if (status === 'good') {
    return 'Good'
  }
  if (status === 'needs-work') {
    return 'Needs work'
  }
  return 'Poor'
}

function documentKey(document: SeoScanDocument): string {
  return `${document.collection}:${String(document.id)}:${document.locale}`
}

const CSV_HEADER = [
  'collection',
  'id',
  'locale',
  'label',
  'slug',
  'seo_title',
  'seo_description',
  'score',
  'status',
  'issues',
]

type CsvImportRow = {
  collection: string
  description?: string
  id: number | string
  key: string
  locale: string
  title?: string
}

function normalizeHeaderName(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z]/g, '')
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n')
}

/**
 * Maps parsed CSV rows onto import entries. Column order is free; headers are
 * matched by name so hand-made sheets work too (`title`/`seo_title`,
 * `description`/`seo_description`).
 */
function readImportRows(rows: string[][]): { invalid: number; parsed: CsvImportRow[] } {
  const [header, ...body] = rows
  if (!header) {
    throw new Error('The CSV file is empty.')
  }

  const columns = new Map<string, number>()
  header.forEach((name, index) => {
    columns.set(normalizeHeaderName(name), index)
  })

  const collectionIndex = columns.get('collection')
  const idIndex = columns.get('id')
  const localeIndex = columns.get('locale')
  const titleIndex = columns.get('seotitle') ?? columns.get('title')
  const descriptionIndex = columns.get('seodescription') ?? columns.get('description')

  if (collectionIndex === undefined || idIndex === undefined || localeIndex === undefined) {
    throw new Error('The CSV file must contain "collection", "id", and "locale" columns.')
  }

  if (titleIndex === undefined && descriptionIndex === undefined) {
    throw new Error('The CSV file must contain a "seo_title" or "seo_description" column.')
  }

  const parsed: CsvImportRow[] = []
  let invalid = 0

  for (const row of body) {
    const collection = row[collectionIndex]?.trim() ?? ''
    const rawId = row[idIndex]?.trim() ?? ''
    const locale = row[localeIndex]?.trim() ?? ''

    if (!collection || !rawId || !locale) {
      invalid += 1
      continue
    }

    const id = /^\d+$/.test(rawId) ? Number(rawId) : rawId

    parsed.push({
      id,
      collection,
      description:
        descriptionIndex === undefined ? undefined : normalizeText(row[descriptionIndex] ?? ''),
      key: `${collection}:${rawId}:${locale}`,
      locale,
      title: titleIndex === undefined ? undefined : normalizeText(row[titleIndex] ?? ''),
    })
  }

  return { invalid, parsed }
}

export function SeoOverviewGlobal({ collections, defaultLocale, locales }: SeoOverviewGlobalProps) {
  const { permissions } = useAuth()
  const {
    config: { routes },
  } = useConfig()
  const [selected, setSelected] = React.useState(() => collections.map((entry) => entry.slug))
  const [locale, setLocale] = React.useState(defaultLocale)
  const [running, setRunning] = React.useState(false)
  const [documents, setDocuments] = React.useState<SeoScanDocument[]>([])
  const [progress, setProgress] = React.useState({ completed: 0, total: 0 })
  const [currentTask, setCurrentTask] = React.useState('Ready to scan')
  const [failed, setFailed] = React.useState(0)
  const [search, setSearch] = React.useState('')
  const [filter, setFilter] = React.useState<ScoreFilter>('all')
  const [editingKey, setEditingKey] = React.useState<null | string>(null)
  const [draftTitle, setDraftTitle] = React.useState('')
  const [draftDescription, setDraftDescription] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [importing, setImporting] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    const allowed = new Set(collections.map((entry) => entry.slug))
    setSelected((previous) => {
      const valid = previous.filter((slug) => allowed.has(slug))
      return valid.length ? valid : collections.map((entry) => entry.slug)
    })
  }, [collections])

  const handleEvent = React.useCallback((event: SeoScanEvent) => {
    switch (event.type) {
      case 'collection-error':
        setFailed((previous) => previous + 1)
        toast.error(`${event.collection}: ${event.message}`)
        break
      case 'collection-start':
        setCurrentTask(`Scanning ${event.label} (${event.totalDocuments} documents)…`)
        break
      case 'document-result':
        setDocuments((previous) => [...previous, event.document])
        setProgress((previous) => ({
          completed: Math.min(previous.total, previous.completed + 1),
          total: previous.total,
        }))
        break
      case 'error':
        setCurrentTask('Scan failed')
        setRunning(false)
        toast.error(event.message)
        break
      case 'scan-complete':
        setFailed(event.failed)
        setProgress((previous) => ({ completed: event.processed, total: previous.total }))
        setCurrentTask('Scan complete')
        setRunning(false)
        toast.success(`SEO scan completed for ${event.processed} document(s).`)
        break
      case 'scan-start':
        setProgress({ completed: 0, total: event.totalDocuments })
        setCurrentTask(`Scanning ${event.totalCollections} collection(s)…`)
        break
    }
  }, [])

  const startScan = async () => {
    if (!selected.length || running) {
      return
    }

    setRunning(true)
    setDocuments([])
    setFailed(0)
    setEditingKey(null)
    setProgress({ completed: 0, total: 0 })
    setCurrentTask('Preparing scan…')

    try {
      await runSeoScan(selected, locale, handleEvent)
    } catch (error) {
      setRunning(false)
      setCurrentTask('Scan failed')
      toast.error(error instanceof Error ? error.message : 'SEO scan failed.')
    }
  }

  const toggleCollection = (slug: string) =>
    setSelected((previous) =>
      previous.includes(slug) ? previous.filter((entry) => entry !== slug) : [...previous, slug],
    )

  const toggleAll = () =>
    setSelected((previous) =>
      previous.length === collections.length ? [] : collections.map((entry) => entry.slug),
    )

  const startEdit = (document: SeoScanDocument) => {
    setEditingKey(documentKey(document))
    setDraftTitle(document.title)
    setDraftDescription(document.description)
  }

  const saveEdit = async (document: SeoScanDocument) => {
    setSaving(true)
    try {
      const updated = await updateSeoMetadata({
        id: document.id,
        collection: document.collection,
        description: draftDescription,
        locale: document.locale,
        title: draftTitle,
      })
      setDocuments((previous) =>
        previous.map((entry) => (documentKey(entry) === documentKey(updated) ? updated : entry)),
      )
      setEditingKey(null)
      toast.success('SEO metadata updated and rescored.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update SEO metadata.')
    } finally {
      setSaving(false)
    }
  }

  const exportCsv = () => {
    if (!documents.length) {
      return
    }

    const rows = [
      CSV_HEADER,
      ...documents.map((document) => [
        document.collection,
        String(document.id),
        document.locale,
        document.label,
        document.slug ?? '',
        document.title,
        document.description,
        String(document.score),
        document.status,
        document.issues.join(' | '),
      ]),
    ]

    const date = new Date().toISOString().slice(0, 10)
    downloadCsv(`seo-export-${locale}-${date}.csv`, serializeCsv(rows))
    toast.success(`Exported ${documents.length} document(s) to CSV.`)
  }

  const importCsv = async (file: File) => {
    setImporting(true)

    try {
      const { invalid, parsed } = readImportRows(parseCsv(await file.text()))
      const documentsByKey = new Map(documents.map((entry) => [documentKey(entry), entry]))

      const updates: Array<{ description: string; row: CsvImportRow; title: string }> = []
      let skippedUnchanged = 0
      let skippedIncomplete = invalid

      for (const row of parsed) {
        const existing = documentsByKey.get(row.key)

        // The update endpoint writes both fields, so a missing column can
        // only be backfilled from a scanned row — never with an empty value.
        const title = row.title ?? existing?.title
        const description = row.description ?? existing?.description
        if (title === undefined || description === undefined) {
          skippedIncomplete += 1
          continue
        }

        if (
          existing &&
          normalizeText(existing.title) === title &&
          normalizeText(existing.description) === description
        ) {
          skippedUnchanged += 1
          continue
        }

        updates.push({ description, row, title })
      }

      if (!updates.length) {
        toast.info(
          `Nothing to import: ${skippedUnchanged} row(s) unchanged, ${skippedIncomplete} row(s) incomplete.`,
        )
        return
      }

      const ok = window.confirm(
        [
          `Apply SEO metadata from CSV to ${updates.length} document(s)?`,
          skippedUnchanged ? `${skippedUnchanged} unchanged row(s) will be skipped.` : '',
          skippedIncomplete ? `${skippedIncomplete} incomplete row(s) will be skipped.` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      if (!ok) {
        return
      }

      setProgress({ completed: 0, total: updates.length })
      let applied = 0
      let failedRows = 0

      for (const update of updates) {
        setCurrentTask(`Importing ${update.row.collection}#${String(update.row.id)}…`)

        try {
          const updated = await updateSeoMetadata({
            id: update.row.id,
            collection: update.row.collection,
            description: update.description,
            locale: update.row.locale,
            title: update.title,
          })

          setDocuments((previous) => {
            const key = documentKey(updated)
            const exists = previous.some((entry) => documentKey(entry) === key)
            return exists
              ? previous.map((entry) => (documentKey(entry) === key ? updated : entry))
              : [...previous, updated]
          })
          applied += 1
        } catch (error) {
          failedRows += 1
          toast.error(
            `${update.row.collection}#${String(update.row.id)}: ${
              error instanceof Error ? error.message : 'Import failed.'
            }`,
          )
        }

        setProgress((previous) => ({
          completed: Math.min(previous.total, previous.completed + 1),
          total: previous.total,
        }))
      }

      setCurrentTask('CSV import complete')
      if (failedRows) {
        toast.warning(`CSV import finished: ${applied} updated, ${failedRows} failed.`)
      } else {
        toast.success(`CSV import finished: ${applied} document(s) updated and rescored.`)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to import CSV file.')
    } finally {
      setImporting(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  const stats = React.useMemo(() => {
    const totalScore = documents.reduce((sum, document) => sum + document.score, 0)
    return {
      average: documents.length ? Math.round(totalScore / documents.length) : 0,
      good: documents.filter((document) => document.status === 'good').length,
      needsWork: documents.filter((document) => document.status === 'needs-work').length,
      poor: documents.filter((document) => document.status === 'poor').length,
    }
  }, [documents])

  const visibleDocuments = React.useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return documents
      .filter((document) => filter === 'all' || document.status === filter)
      .filter(
        (document) =>
          !query ||
          document.label.toLocaleLowerCase().includes(query) ||
          document.title.toLocaleLowerCase().includes(query) ||
          document.collection.toLocaleLowerCase().includes(query) ||
          document.slug?.toLocaleLowerCase().includes(query),
      )
      .sort((left, right) => left.score - right.score || left.label.localeCompare(right.label))
  }, [documents, filter, search])

  const scoreFilters: Array<{ label: string; value: ScoreFilter }> = [
    { label: `All (${documents.length})`, value: 'all' },
    { label: `Poor (${stats.poor})`, value: 'poor' },
    { label: `Needs work (${stats.needsWork})`, value: 'needs-work' },
    { label: `Good (${stats.good})`, value: 'good' },
  ]

  return (
    <ToolPage running={running || importing}>
      <ToolPanel
        description="Scan all configured documents, prioritize weak pages, and edit the Payload SEO title and description without leaving this overview — inline, or in bulk via CSV export and import."
        eyebrow="Content audit"
        title="SEO overview"
      >
        <CheckboxCardGroup
          disabled={running}
          label="Collections"
          onToggle={toggleCollection}
          onToggleAll={toggleAll}
          options={collections.map((entry) => ({
            key: entry.slug,
            meta: entry.slug,
            title: entry.label,
          }))}
          selectedKeys={selected}
        />

        <ToolSection>
          <div className={styles.controlsRow}>
            <div className={styles.localeField}>
              <label className={toolStyles.fieldLabel} htmlFor="seo-overview-locale">
                Locale
              </label>
              <select
                className={toolStyles.select}
                disabled={running}
                id="seo-overview-locale"
                onChange={(event) => setLocale(event.target.value)}
                value={locale}
              >
                {locales.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </div>

            <Button
              disabled={running || importing || !selected.length}
              onClick={() => void startScan()}
              type="button"
            >
              {running ? 'Scanning…' : 'Run full scan'}
            </Button>
          </div>
        </ToolSection>

        {running || importing || progress.total > 0 ? (
          <ToolSection>
            <ProgressSection
              completed={progress.completed}
              status={failed ? `${currentTask} · ${failed} failed` : currentTask}
              total={progress.total}
            />
          </ToolSection>
        ) : null}
      </ToolPanel>

      {documents.length > 0 || running ? (
        <ToolPanel>
          <StatGrid
            stats={[
              { label: 'Average score', value: stats.average },
              { label: 'Good', tone: stats.good ? 'success' : 'default', value: stats.good },
              {
                label: 'Needs work',
                tone: stats.needsWork ? 'warning' : 'default',
                value: stats.needsWork,
              },
              { label: 'Poor', tone: stats.poor ? 'error' : 'default', value: stats.poor },
            ]}
          />
        </ToolPanel>
      ) : null}

      <ToolPanel>
        <div className={styles.toolbar}>
          <input
            aria-label="Search SEO results"
            className={`${toolStyles.input} ${styles.search}`}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search document, title, slug or collection…"
            type="search"
            value={search}
          />
          <div className={toolStyles.chipRow} role="group">
            {scoreFilters.map((option) => (
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
          <div className={styles.toolbarActions}>
            <Button
              buttonStyle="secondary"
              disabled={running || importing || !documents.length}
              onClick={exportCsv}
              size="small"
              type="button"
            >
              Export CSV
            </Button>
            <Button
              buttonStyle="secondary"
              disabled={running || importing}
              onClick={() => fileInputRef.current?.click()}
              size="small"
              type="button"
            >
              {importing ? 'Importing…' : 'Import CSV'}
            </Button>
            <input
              accept=".csv,text/csv"
              aria-label="Import SEO metadata from CSV"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) {
                  void importCsv(file)
                }
              }}
              ref={fileInputRef}
              type="file"
            />
          </div>
        </div>

        {!documents.length ? (
          <p className={toolStyles.empty}>Run a full scan to build the SEO overview.</p>
        ) : !visibleDocuments.length ? (
          <p className={toolStyles.empty}>No documents match the current filters.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Score</th>
                  <th>SEO title</th>
                  <th>Description</th>
                  <th>Content</th>
                  <th>Issues</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {visibleDocuments.map((document) => {
                  const key = documentKey(document)
                  const canUpdate = Boolean(permissions?.collections?.[document.collection]?.update)
                  const href = `${routes.admin}/collections/${encodeURIComponent(
                    document.collection,
                  )}/${encodeURIComponent(String(document.id))}?locale=${encodeURIComponent(
                    document.locale,
                  )}`

                  return (
                    <React.Fragment key={key}>
                      <tr>
                        <td>
                          <a className={styles.documentLink} href={href}>
                            {document.label}
                          </a>
                          <div className={styles.documentMeta}>
                            {document.collection} · {String(document.id)}
                            {document.slug ? ` · /${document.slug}` : ''}
                          </div>
                        </td>
                        <td>
                          <span
                            className={`${styles.score} ${statusClass(document.status)}`}
                            title={statusLabel(document.status)}
                          >
                            {document.score}
                          </span>
                        </td>
                        <td>
                          <span className={styles.metaText}>
                            {document.title || <em>Missing</em>}
                          </span>
                          <span className={styles.length}>{document.title.length} chars</span>
                        </td>
                        <td>
                          <span className={styles.metaText}>
                            {document.description || <em>Missing</em>}
                          </span>
                          <span className={styles.length}>{document.description.length} chars</span>
                        </td>
                        <td>
                          {document.wordCount} words
                          <div className={styles.documentMeta}>
                            {document.headingCount} heading(s)
                          </div>
                        </td>
                        <td>
                          {document.issues.length ? (
                            <ul className={styles.issues}>
                              {document.issues.slice(0, 3).map((issue) => (
                                <li key={issue}>{issue}</li>
                              ))}
                              {document.issues.length > 3 && (
                                <li>+{document.issues.length - 3} more</li>
                              )}
                            </ul>
                          ) : (
                            <span className={styles.muted}>No issues</span>
                          )}
                        </td>
                        <td>
                          <Button
                            buttonStyle="secondary"
                            disabled={!canUpdate || saving || importing}
                            onClick={() =>
                              editingKey === key ? setEditingKey(null) : startEdit(document)
                            }
                            size="small"
                            type="button"
                          >
                            {editingKey === key ? 'Cancel' : 'Edit'}
                          </Button>
                        </td>
                      </tr>
                      {editingKey === key && (
                        <tr
                          aria-label={`Edit SEO metadata for ${document.label}`}
                          className={styles.editorRow}
                        >
                          <td aria-label="SEO metadata editor" colSpan={7}>
                            <div className={styles.editor}>
                              <div className={toolStyles.field}>
                                <label
                                  className={toolStyles.fieldLabel}
                                  htmlFor={`seo-title-${key}`}
                                >
                                  SEO title
                                </label>
                                <input
                                  aria-label={`SEO title for ${document.label}`}
                                  className={toolStyles.input}
                                  id={`seo-title-${key}`}
                                  maxLength={180}
                                  onChange={(event) => setDraftTitle(event.target.value)}
                                  value={draftTitle}
                                />
                                <span className={styles.length}>
                                  {draftTitle.length} characters · target 50–60
                                </span>
                              </div>
                              <div className={toolStyles.field}>
                                <label
                                  className={toolStyles.fieldLabel}
                                  htmlFor={`seo-description-${key}`}
                                >
                                  SEO description
                                </label>
                                <textarea
                                  aria-label={`SEO description for ${document.label}`}
                                  className={toolStyles.textarea}
                                  id={`seo-description-${key}`}
                                  maxLength={400}
                                  onChange={(event) => setDraftDescription(event.target.value)}
                                  value={draftDescription}
                                />
                                <span className={styles.length}>
                                  {draftDescription.length} characters · target 100–150
                                </span>
                              </div>
                              <div className={styles.editorActions}>
                                <Button
                                  disabled={saving}
                                  onClick={() => void saveEdit(document)}
                                  size="small"
                                  type="button"
                                >
                                  {saving ? 'Saving…' : 'Save and rescore'}
                                </Button>
                                <Button
                                  buttonStyle="secondary"
                                  disabled={saving}
                                  onClick={() => setEditingKey(null)}
                                  size="small"
                                  type="button"
                                >
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </ToolPanel>
    </ToolPage>
  )
}
