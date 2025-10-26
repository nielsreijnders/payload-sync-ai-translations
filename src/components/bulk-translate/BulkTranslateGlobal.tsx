'use client'

import { Button, toast, useConfig, useForm } from '@payloadcms/ui'
import * as React from 'react'

import { type AnyField, collectLocalizedFieldPatterns } from '../../utils/localizedFields.js'
import {
  buildTranslationRequest,
  type LocalePreparationInput,
  localeRequiresManualReview,
  type LocaleTranslationSelection,
  prepareLocalesForTranslation,
} from '../../utils/translationPlan.js'
import { buildTranslatableItems } from '../auto-translate-button/utils/buildTranslatableItems.js'
import { performTranslations } from '../auto-translate-button/utils/performTranslations.js'
import { requestTranslationReview } from '../auto-translate-button/utils/requestTranslationReview.js'
import styles from './BulkTranslateGlobal.module.css'

type CollectionOption = {
  label: string
  slug: string
}

type BulkTranslateGlobalProps = {
  collections: CollectionOption[]
  defaultLocale: string
  locales: string[]
}

type ListResponse<T> = {
  docs: T[]
  page: number
  totalDocs: number
  totalPages: number
}

type LogEntry = {
  collection: string
  id: string
  message: string
  status: 'error' | 'info' | 'success'
  timestamp: number
}

type CollectionDoc = {
  _id?: number | string
  id?: number | string
} & Record<string, unknown>

const PAGE_SIZE = 25

function resolveDocId(doc: CollectionDoc): null | string {
  const identifier = doc.id ?? doc._id
  if (typeof identifier === 'number') {
    return String(identifier)
  }
  if (typeof identifier === 'string' && identifier.trim()) {
    return identifier
  }
  return null
}

export function BulkTranslateGlobal(props: BulkTranslateGlobalProps) {
  const { collections, defaultLocale: fallbackDefaultLocale, locales: providedLocales } = props
  const form = useForm()
  const config = useConfig()
  const [logs, setLogs] = React.useState<LogEntry[]>([])
  const [running, setRunning] = React.useState(false)
  const [currentStatus, setCurrentStatus] = React.useState<null | string>(null)
  const [progress, setProgress] = React.useState({ completed: 0, total: 0 })

  const appendLog = React.useCallback((entry: Omit<LogEntry, 'timestamp'>) => {
    setLogs((previous) => [...previous, { ...entry, timestamp: Date.now() }])
  }, [])

  const clearLogs = React.useCallback(() => {
    setLogs([])
  }, [])

  const resolvedDefaultLocale = React.useMemo(() => {
    const fromConfig = config?.localization?.defaultLocale
    return fromConfig || fallbackDefaultLocale || 'en'
  }, [config?.localization?.defaultLocale, fallbackDefaultLocale])

  const availableLocales = React.useMemo(() => {
    const sources = providedLocales.length
      ? providedLocales
      : (config?.localization?.locales ?? [])
          .map((locale) => (typeof locale === 'string' ? locale : locale?.code))
          .filter((locale): locale is string => typeof locale === 'string' && locale.length > 0)

    const filtered = sources.filter((locale) => locale && locale !== resolvedDefaultLocale)
    return Array.from(new Set(filtered))
  }, [config?.localization?.locales, providedLocales, resolvedDefaultLocale])

  const fieldPatterns = React.useMemo(() => {
    const patterns = new Map<string, string[]>()
    const configCollections = config?.collections ?? []

    collections.forEach((option) => {
      const match = configCollections.find((collection) => collection.slug === option.slug)
      if (!match) {
        return
      }

      const fields = (match as { fields?: AnyField[] }).fields ?? []
      patterns.set(option.slug, collectLocalizedFieldPatterns(fields))
    })

    return patterns
  }, [collections, config?.collections])

  const totalPercentage = React.useMemo(() => {
    if (!progress.total) {
      return 0
    }
    return Math.round((progress.completed / progress.total) * 100)
  }, [progress])

  const getSelectedCollectionSlugs = React.useCallback(() => {
    const data = form?.getData?.()
    const values = Array.isArray((data as { collections?: unknown }).collections)
      ? ((data as { collections?: unknown[] }).collections ?? [])
      : []
    return values.filter((value): value is string => typeof value === 'string' && value.length > 0)
  }, [form])

  const fetchCollectionPage = React.useCallback(
    async (
      slug: string,
      page: number,
      limit: number,
    ): Promise<ListResponse<CollectionDoc> | null> => {
      const params = new URLSearchParams({
        depth: '0',
        limit: String(limit),
        locale: resolvedDefaultLocale,
        page: String(page),
      })

      try {
        const response = await fetch(`/api/${slug}?${params.toString()}`, {
          credentials: 'include',
        })

        if (!response.ok) {
          const text = await response.text().catch(() => '')
          appendLog({
            id: '—',
            collection: slug,
            message: `Failed to fetch documents (${response.status} ${response.statusText}) ${text}`.trim(),
            status: 'error',
          })
          return null
        }

        const body = (await response.json()) as ListResponse<CollectionDoc>
        if (!body || !Array.isArray(body.docs)) {
          appendLog({
            id: '—',
            collection: slug,
            message: 'Unexpected response when loading documents.',
            status: 'error',
          })
          return null
        }

        return body
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load collection documents.'
        appendLog({ id: '—', collection: slug, message, status: 'error' })
        return null
      }
    },
    [appendLog, resolvedDefaultLocale],
  )

  const processDocument = React.useCallback(
    async (
      slug: string,
      doc: CollectionDoc,
      patterns: string[],
      targetLocales: string[],
    ) => {
      const identifier = resolveDocId(doc)
      if (!identifier) {
        appendLog({
          id: '—',
          collection: slug,
          message: 'Document is missing an identifier; skipping.',
          status: 'error',
        })
        return
      }

      const docLabel = identifier
      setCurrentStatus(`Preparing ${slug} • ${docLabel}…`)

      const items = buildTranslatableItems(doc, patterns)
      if (!items.length) {
        appendLog({
          id: docLabel,
          collection: slug,
          message: 'No translatable fields found; skipping.',
          status: 'info',
        })
        return
      }

      let reviewSource: null | ReturnType<typeof requestTranslationReview> = null

      try {
        reviewSource = await requestTranslationReview({
          id: docLabel,
          collection: slug,
          defaultLocale: resolvedDefaultLocale,
          items,
          locales: targetLocales,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Translation review failed.'
        appendLog({ id: docLabel, collection: slug, message, status: 'error' })
        return
      }

      if (!reviewSource) {
        appendLog({
          id: docLabel,
          collection: slug,
          message: 'Translation review failed.',
          status: 'error',
        })
        return
      }

      const normalizedLocales: LocalePreparationInput[] = reviewSource.locales.map((locale) => {
        const overrides: Record<number, string> = {}
        for (const suggestion of locale.suggestions ?? []) {
          if (Number.isInteger(suggestion.index) && typeof suggestion.text === 'string') {
            overrides[suggestion.index] = suggestion.text
          }
        }

        return {
          code: locale.code,
          overrides,
          skipped: [],
          translateIndexes: locale.translateIndexes,
        }
      })

      const localesRequiringReview = reviewSource.locales.filter(localeRequiresManualReview)

      const preparedLocales = prepareLocalesForTranslation(items, normalizedLocales)

      const actionableLocales: LocaleTranslationSelection[] = preparedLocales.filter((locale) => {
        const source = reviewSource?.locales.find((candidate) => candidate.code === locale.code)
        return source ? !localeRequiresManualReview(source) : true
      })

      if (!actionableLocales.length) {
        if (localesRequiringReview.length) {
          const codes = localesRequiringReview.map((locale) => locale.code).join(', ')
          appendLog({
            id: docLabel,
            collection: slug,
            message: `Skipped. Manual review required for: ${codes}.`,
            status: 'info',
          })
        } else {
          appendLog({
            id: docLabel,
            collection: slug,
            message: 'All locales are up-to-date.',
            status: 'info',
          })
        }
        return
      }

      const translationRequest = buildTranslationRequest({
        collection: slug,
        defaultLocale: resolvedDefaultLocale,
        documentID: docLabel,
        items,
        locales: actionableLocales,
      })

      if (!translationRequest) {
        appendLog({
          id: docLabel,
          collection: slug,
          message: 'No locales required translation after preparation.',
          status: 'info',
        })
        return
      }

      let lastError: null | string = null

      const callbacks = {
        onApplied: (locale: string) => {
          setCurrentStatus(`Saved ${slug} • ${docLabel} (${locale})`)
        },
        onDone: () => {
          setCurrentStatus(`Completed ${slug} • ${docLabel}`)
        },
        onError: (message: string) => {
          lastError = message
          setCurrentStatus(null)
        },
        onMissingBody: () => {
          lastError = 'The server did not return any data.'
          setCurrentStatus(null)
        },
        onProgress: ({ completed, locale, total }: { completed: number; locale: string; total: number }) => {
          const percentage = total ? Math.round((completed / total) * 100) : 0
          setCurrentStatus(
            `Translating ${slug} • ${docLabel} (${locale}) ${completed}/${total} (${percentage}%)`,
          )
        },
        onStart: () => {
          setCurrentStatus(`Starting ${slug} • ${docLabel}…`)
        },
        onUnexpectedResponse: (status: number, statusText: string, bodyText: string) => {
          const detail = [statusText, bodyText].filter(Boolean).join(' ')
          lastError = `Server error: ${status} ${detail}`.trim()
          setCurrentStatus(null)
        },
      }

      try {
        const { finished, hadError } = await performTranslations(translationRequest, callbacks)
        if (hadError) {
          appendLog({
            id: docLabel,
            collection: slug,
            message: lastError || 'Translation failed.',
            status: 'error',
          })
          return
        }

        const translatedLocales = actionableLocales.map((locale) => locale.code).join(', ')
        const suffix = finished ? '' : ' (partial)'
        const manualCodes = localesRequiringReview.map((locale) => locale.code)
        const manualSuffix = manualCodes.length
          ? `; manual review required for: ${manualCodes.join(', ')}`
          : ''
        appendLog({
          id: docLabel,
          collection: slug,
          message: `Updated locales: ${translatedLocales || 'none'}${suffix}${manualSuffix}`,
          status: 'success',
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Translation failed.'
        appendLog({ id: docLabel, collection: slug, message, status: 'error' })
      }
    },
    [appendLog, resolvedDefaultLocale],
  )

  const processCollection = React.useCallback(
    async (slug: string, targetLocales: string[], patterns: string[]): Promise<number> => {
      let page = 1
      let totalPages = 1
      let processed = 0

      do {
        const pageData = await fetchCollectionPage(slug, page, PAGE_SIZE)
        if (!pageData) {
          return processed
        }

        totalPages = pageData.totalPages || 1

        for (const doc of pageData.docs) {
          await processDocument(slug, doc, patterns, targetLocales)
          setProgress((previous) => ({ ...previous, completed: previous.completed + 1 }))
          processed += 1
        }

        page += 1
      } while (page <= totalPages)
      return processed
    },
    [fetchCollectionPage, processDocument],
  )

  const handleRun = React.useCallback(async () => {
    if (running) {
      return
    }

    const selected = getSelectedCollectionSlugs()
    if (!selected.length) {
      toast.info('Select at least one collection above before running the bulk translator.')
      return
    }

    if (!availableLocales.length) {
      toast.info('No additional locales configured for translation.')
      return
    }

    setRunning(true)
    setCurrentStatus('Preparing bulk translation…')
    setProgress({ completed: 0, total: 0 })
    clearLogs()

    try {
      const totals = new Map<string, number>()
      let aggregateTotal = 0

      for (const slug of selected) {
        const firstPage = await fetchCollectionPage(slug, 1, 1)
        if (!firstPage) {
          continue
        }

        totals.set(slug, firstPage.totalDocs || 0)
        aggregateTotal += firstPage.totalDocs || 0

        if (!firstPage.totalDocs) {
          appendLog({
            id: '—',
            collection: slug,
            message: 'No documents found for this collection.',
            status: 'info',
          })
        }
      }

      if (!aggregateTotal) {
        setCurrentStatus(null)
        appendLog({
          id: '—',
          collection: '—',
          message: 'No documents to translate for the selected collections.',
          status: 'info',
        })
        return
      }

      setProgress({ completed: 0, total: aggregateTotal })
      setCurrentStatus('Running bulk translation…')

      for (const slug of selected) {
        const patterns = fieldPatterns.get(slug)
        if (!patterns || !patterns.length) {
          appendLog({
            id: '—',
            collection: slug,
            message: 'No localized fields configured; skipping collection.',
            status: 'info',
          })
          setProgress((previous) => ({
            completed: previous.completed + (totals.get(slug) || 0),
            total: previous.total,
          }))
          continue
        }

        if ((totals.get(slug) || 0) === 0) {
          continue
        }

        const processed = await processCollection(slug, availableLocales, patterns)
        const expected = totals.get(slug) || 0
        if (processed < expected) {
          const remaining = expected - processed
          if (remaining > 0) {
            setProgress((previous) => ({
              completed: previous.completed + remaining,
              total: previous.total,
            }))
          }
        }
      }

      setCurrentStatus(null)
      appendLog({
        id: '—',
        collection: '—',
        message: 'Bulk translation complete.',
        status: 'success',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Bulk translation failed.'
      appendLog({ id: '—', collection: '—', message, status: 'error' })
    } finally {
      setRunning(false)
      setCurrentStatus(null)
    }
  }, [
    appendLog,
    availableLocales,
    clearLogs,
    fieldPatterns,
    fetchCollectionPage,
    getSelectedCollectionSlugs,
    processCollection,
    running,
  ])

  const progressLabel = `${progress.completed}/${progress.total}`

  return (
    <section className={styles.wrapper}>
      <div className={styles.intro}>
        <h2 className={styles.title}>AI bulk translation</h2>
        <p className={styles.description}>
          Select the collections above and run bulk translation to synchronize all documents across
          the remaining locales.
        </p>
      </div>

      <div className={styles.actions}>
        <Button disabled={running} onClick={handleRun} type="button">
          {running ? 'Running…' : 'Start bulk translation'}
        </Button>
        <Button disabled={running || logs.length === 0} onClick={clearLogs} type="button">
          Clear log
        </Button>
      </div>

      <div className={styles.progressContainer}>
        <div
          aria-label="Bulk translation progress"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={totalPercentage}
          className={styles.progressBar}
          role="progressbar"
        >
          <div className={styles.progressFill} style={{ width: `${totalPercentage}%` }} />
        </div>
        <div className={styles.progressMeta}>
          {progressLabel} documents processed{progress.total ? ` (${totalPercentage}%)` : ''}
        </div>
        {currentStatus ? <div className={styles.status}>{currentStatus}</div> : null}
      </div>

      <div className={styles.logSection}>
        <h3 className={styles.logHeader}>Activity log</h3>
        {logs.length ? (
          <ul className={styles.logList}>
            {logs.map((entry) => {
              const classNames = [styles.logItem]
              if (entry.status === 'success') {
                classNames.push(styles.logSuccess)
              } else if (entry.status === 'error') {
                classNames.push(styles.logError)
              } else {
                classNames.push(styles.logInfo)
              }

              return (
                <li className={classNames.join(' ')} key={entry.timestamp}>
                  <span className={styles.badge}>
                    {entry.collection} • {entry.id}
                  </span>
                  <p className={styles.logMessage}>{entry.message}</p>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className={styles.emptyState}>No activity yet. Run the bulk translator to see results here.</p>
        )}
      </div>
    </section>
  )
}
