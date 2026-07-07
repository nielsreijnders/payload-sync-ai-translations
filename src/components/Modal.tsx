'use client'

import { Button, Modal } from '@payloadcms/ui'
import { Info } from 'lucide-react'
import * as React from 'react'

import type { TranslateReviewLocale } from '../server/translationTypes.js'
import type { DiffSegment } from './shared/wordDiff.js'

import { stripLexicalMarkers } from '../utils/lexical.js'
import styles from './Modal.module.css'
import { diffWords } from './shared/wordDiff.js'

type PendingReviewLocale = {
  overrides: Record<number, string>
  skipped: number[]
} & TranslateReviewLocale

type PendingReview = { locales: PendingReviewLocale[] }

type AutoTranslateReviewModalProps = {
  cancelReview: () => void
  confirmReview: () => void
  defaultLocale?: string
  modalBusy: boolean
  pendingReview: null | PendingReview
  slug: string
  updateLocaleOverride: (locale: string, index: number, value: string) => void
  updateLocaleSkip: (locale: string, index: number, skip: boolean) => void
}

function SegmentedText({
  segments,
  tone,
}: {
  segments: DiffSegment[]
  tone: 'added' | 'removed'
}) {
  const highlightClass = tone === 'added' ? styles.highlightAdded : styles.highlightRemoved

  return (
    <>
      {segments.map((segment, index) =>
        segment.changed ? (
          <mark className={highlightClass} key={index}>
            {segment.text}
          </mark>
        ) : (
          <React.Fragment key={index}>{segment.text}</React.Fragment>
        ),
      )}
    </>
  )
}

/**
 * Labeled source/current/suggestion comparison. The current translation and
 * the suggestion get a word-level diff so the actual change is visible at a
 * glance instead of asking editors to spot it themselves.
 */
function ComparisonBlock({
  currentText,
  defaultLocale,
  localeCode,
  sourceText,
  suggestionText,
}: {
  currentText?: string
  defaultLocale?: string
  localeCode: string
  sourceText: string
  suggestionText?: string
}) {
  const source = stripLexicalMarkers(sourceText)
  const current = currentText ? stripLexicalMarkers(currentText) : ''
  const suggestion = suggestionText ? stripLexicalMarkers(suggestionText) : ''
  const showCurrent = Boolean(current) && current !== suggestion

  const diff = React.useMemo(
    () => (showCurrent && suggestion ? diffWords(current, suggestion) : null),
    [current, showCurrent, suggestion],
  )

  const sourceLabel = defaultLocale ? defaultLocale.toUpperCase() : 'SOURCE'
  const targetLabel = localeCode.toUpperCase()

  return (
    <div className={styles.comparison}>
      <div className={styles.comparisonRow}>
        <span className={styles.rowLabel}>
          Source <span className={styles.rowLocale}>{sourceLabel}</span>
        </span>
        <p className={styles.rowText}>{source || '—'}</p>
      </div>

      {showCurrent ? (
        <div className={`${styles.comparisonRow} ${styles.rowCurrent}`}>
          <span className={styles.rowLabel}>
            Current <span className={styles.rowLocale}>{targetLabel}</span>
          </span>
          <p className={styles.rowText}>
            {diff ? <SegmentedText segments={diff.before} tone="removed" /> : current}
          </p>
        </div>
      ) : null}

      <div className={`${styles.comparisonRow} ${styles.rowSuggestion}`}>
        <span className={styles.rowLabel}>
          Suggestion <span className={styles.rowLocale}>{targetLabel}</span>
        </span>
        <p className={styles.rowText}>
          {diff ? <SegmentedText segments={diff.after} tone="added" /> : suggestion || '—'}
        </p>
      </div>
    </div>
  )
}

export function AutoTranslateReviewModal(props: AutoTranslateReviewModalProps) {
  const {
    slug,
    cancelReview,
    confirmReview,
    defaultLocale,
    modalBusy,
    pendingReview,
    updateLocaleOverride,
    updateLocaleSkip,
  } = props

  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({})

  if (!pendingReview) {
    return <Modal slug={slug} />
  }

  return (
    <Modal slug={slug}>
      <div className={styles.modalContent}>
        <header className={styles.introMinimal}>
          <h2 className={styles.introTitle}>Review translation updates</h2>
          <p className={styles.introDescription}>
            The default language contains changes that are missing from the translations below.
            Compare each current translation with the suggestion, edit or skip where needed, then
            apply.
          </p>
        </header>

        {pendingReview.locales.map((locale) => (
          <section className={styles.localeSection} key={locale.code}>
            <header className={styles.localeHeader}>
              <span className={styles.localeBadge}>{locale.code}</span>
              <span className={styles.localeStats}>{locale.mismatches.length} field(s)</span>
            </header>

            {locale.mismatches.length === 0 ? (
              <p className={styles.emptyState}>
                No existing translations, missing fields will be translated.
              </p>
            ) : (
              <ul className={styles.diffList}>
                {locale.mismatches.map((item) => {
                  const id = `${locale.code}-${item.index}`
                  const overrideValue = locale.overrides[item.index] ?? ''
                  const isSkipped = locale.skipped.includes(item.index)
                  const showEditor = !!expanded[id]

                  return (
                    <li
                      className={`${styles.diffItem} ${isSkipped ? styles.diffItemSkipped : ''}`}
                      key={id}
                    >
                      <div className={styles.itemHeader}>
                        <span className={styles.path}>{item.path}</span>
                        <div className={styles.actionsRow}>
                          <button
                            aria-expanded={showEditor}
                            className={styles.ghostBtn}
                            disabled={isSkipped}
                            onClick={() => setExpanded((s) => ({ ...s, [id]: !s[id] }))}
                            type="button"
                          >
                            {showEditor ? 'Close editor' : 'Edit'}
                          </button>

                          <button
                            aria-pressed={isSkipped}
                            className={styles.ghostBtn}
                            onClick={() => updateLocaleSkip(locale.code, item.index, !isSkipped)}
                            type="button"
                          >
                            {isSkipped ? 'Include' : 'Skip'}
                          </button>
                        </div>
                      </div>

                      {item.reason ? (
                        <p className={styles.reasonNote}>
                          <Info aria-hidden="true" className={styles.reasonIcon} size={14} />
                          {item.reason}
                        </p>
                      ) : null}

                      <ComparisonBlock
                        currentText={item.existingText}
                        defaultLocale={defaultLocale}
                        localeCode={locale.code}
                        sourceText={item.defaultText}
                        suggestionText={overrideValue || item.existingText}
                      />

                      {showEditor && !isSkipped ? (
                        <div className={styles.editorWrap}>
                          <textarea
                            aria-label={`Custom translation for ${item.path}`}
                            className={styles.textarea}
                            onChange={(e) =>
                              updateLocaleOverride(locale.code, item.index, e.target.value)
                            }
                            placeholder="Enter custom translation (empty = use existing)"
                            rows={3}
                            value={overrideValue}
                          />
                          <p className={styles.editorHint}>
                            The suggestion above updates live while you type.
                          </p>
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        ))}

        <footer className={styles.actionsMinimal}>
          <Button buttonStyle="secondary" disabled={modalBusy} onClick={cancelReview} type="button">
            Cancel
          </Button>
          <Button disabled={modalBusy} onClick={confirmReview} type="button">
            {modalBusy ? 'Working…' : 'Apply changes'}
          </Button>
        </footer>
      </div>
    </Modal>
  )
}

export const REVIEW_MODAL_SLUG = 'auto-translate-review'
