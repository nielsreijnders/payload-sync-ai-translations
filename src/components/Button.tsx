'use client'

import { Button, useModal } from '@payloadcms/ui'
import { Link2, Sparkles } from 'lucide-react'
import * as React from 'react'

import type { AutoTranslateButtonProps } from './auto-translate-button/hooks/types.js'
import { useAutoTranslateButton } from './auto-translate-button/hooks/useAutoTranslateButton.js'
import { useSyncLinksButton } from './auto-translate-button/hooks/useSyncLinksButton.js'
import styles from './AutoTranslateButton.module.css'
import { AutoTranslateReviewModal, REVIEW_MODAL_SLUG } from './Modal.js'

export function AutoTranslateButton(props: AutoTranslateButtonProps) {
  const {
    cancelReview,
    confirmReview,
    disabled,
    handleClick,
    modalBusy,
    pendingReview,
    shouldRender,
    updateLocaleOverride,
    updateLocaleSkip,
  } = useAutoTranslateButton(props)
  const linkControls = useSyncLinksButton(props)

  const { closeModal, openModal } = useModal()

  React.useEffect(() => {
    if (pendingReview) {
      openModal(REVIEW_MODAL_SLUG)
    } else {
      closeModal(REVIEW_MODAL_SLUG)
    }
  }, [closeModal, openModal, pendingReview])

  if (!shouldRender && !linkControls.shouldRender) {
    return null
  }

  return (
    <>
      <div className={styles.buttonGroup}>
        {shouldRender && (
          <Button disabled={disabled} onClick={handleClick} type="button">
            <span className={styles.buttonContent}>
              <Sparkles className={styles.icon} size={14} />
              Synchroniseer vertalingen
            </span>
          </Button>
        )}
        {linkControls.shouldRender && (
          <Button disabled={linkControls.disabled} onClick={linkControls.handleClick} type="button">
            <span className={styles.buttonContent}>
              <Link2 className={styles.icon} size={14} />
              Synchroniseer links
            </span>
          </Button>
        )}
      </div>
      {shouldRender && (
        <AutoTranslateReviewModal
          cancelReview={cancelReview}
          confirmReview={confirmReview}
          modalBusy={modalBusy}
          pendingReview={pendingReview}
          slug={REVIEW_MODAL_SLUG}
          updateLocaleOverride={updateLocaleOverride}
          updateLocaleSkip={updateLocaleSkip}
        />
      )}
    </>
  )
}
