// AutoTranslateReviewModal.tsx
'use client'

import { Button, Modal } from '@payloadcms/ui'
import * as React from 'react'

import type { TranslateReviewLocale } from '../server/types.js'

import styles from './Modal.module.css'

type PendingReviewLocale = {
  overrides: Record<number, string>
  skipped: number[]
} & TranslateReviewLocale

type PendingReview = { locales: PendingReviewLocale[] }

type AutoTranslateReviewModalProps = {
  cancelReview: () => void
  confirmReview: () => void
  modalBusy: boolean
  pendingReview: null | PendingReview
  slug: string
  updateLocaleOverride: (locale: string, index: number, value: string) => void
  updateLocaleSkip: (locale: string, index: number, skip: boolean) => void
}

function DiffBlock({ defaultText, existingText }: { defaultText: string; existingText?: string }) {
  return (
    <div className={styles.diff}>
      <pre className={`${styles.diffLine} ${styles.diffDel}`}>- {defaultText || '—'}</pre>
      <pre className={`${styles.diffLine} ${styles.diffAdd}`}>+ {existingText || '—'}</pre>
    </div>
  )
}

export function AutoTranslateReviewModal(props: AutoTranslateReviewModalProps) {
  const {
    slug,
    cancelReview,
    confirmReview,
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
          <h2 className={styles.introTitle}>Controleer ontbrekende informatie</h2>
          <p className={styles.introDescription}>
            Velden hieronder hebben aandacht nodig t.o.v. de hoofdtaal.
          </p>
        </header>

        {pendingReview.locales.map((locale) => (
          <section className={styles.localeSection} key={locale.code}>
            <header className={styles.localeHeader}>
              <span className={styles.localeBadge}>{locale.code}</span>
              <span className={styles.localeStats}>{locale.mismatches.length} veld(en)</span>
            </header>

            {locale.mismatches.length === 0 ? (
              <p className={styles.emptyState}>
                Geen bestaande vertalingen, ontbrekende velden worden vertaald.
              </p>
            ) : (
              <ul className={styles.diffList}>
                {locale.mismatches.map((item) => {
                  const id = `${locale.code}-${item.index}`
                  const overrideValue = locale.overrides[item.index] ?? ''
                  const isSkipped = locale.skipped.includes(item.index)
                  const showEditor = !!expanded[id]

                  const effectiveTarget = overrideValue || item.existingText || ''

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
                            {showEditor ? 'Sluit editor' : 'Bewerk'}
                          </button>

                          <button
                            aria-pressed={isSkipped}
                            className={styles.ghostBtn}
                            onClick={() => updateLocaleSkip(locale.code, item.index, !isSkipped)}
                            type="button"
                          >
                            {isSkipped ? 'Opnemen' : 'Overslaan'}
                          </button>
                        </div>
                      </div>

                      <DiffBlock
                        defaultText={item.defaultText}
                        existingText={overrideValue || item.existingText}
                      />

                      {showEditor && !isSkipped ? (
                        <div className={styles.editorWrap}>
                          <textarea
                            className={styles.textarea}
                            onChange={(e) =>
                              updateLocaleOverride(locale.code, item.index, e.target.value)
                            }
                            placeholder="Voer aangepaste vertaling in (leeg = gebruik bestaande)"
                            rows={3}
                            value={overrideValue}
                          />
                          {effectiveTarget ? (
                            <div className={styles.previewBox}>
                              <div className={styles.previewLabel}>Voorbeeld</div>
                              <pre className={`${styles.diffLine} ${styles.diffAdd}`}>
                                + {effectiveTarget}
                              </pre>
                            </div>
                          ) : null}
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
          <Button disabled={modalBusy} onClick={cancelReview} type="button" variant="secondary">
            Annuleren
          </Button>
          <Button disabled={modalBusy} onClick={confirmReview} type="button">
            {modalBusy ? 'Bezig…' : 'Doorvoeren'}
          </Button>
        </footer>
      </div>
    </Modal>
  )
}

export const REVIEW_MODAL_SLUG = 'auto-translate-review'
