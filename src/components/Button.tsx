'use client'

import { Button, useModal } from '@payloadcms/ui'
import { Sparkles } from 'lucide-react'
import * as React from 'react'

import {
  type AutoTranslateButtonProps,
  useAutoTranslateButton,
} from './auto-translate-button/hooks/useAutoTranslateButton.js'
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

  const { closeModal, openModal } = useModal()

  React.useEffect(() => {
    if (pendingReview) {
      openModal(REVIEW_MODAL_SLUG)
    } else {
      closeModal(REVIEW_MODAL_SLUG)
    }
  }, [closeModal, openModal, pendingReview])

  if (!shouldRender) {
    return null
  }

  return (
    <>
      <Button disabled={disabled} onClick={handleClick} type="button">
        <span className={styles.buttonContent}>
          <Sparkles className={styles.icon} size={14} />
          Synchroniseer vertalingen
        </span>
      </Button>
      <AutoTranslateReviewModal
        cancelReview={cancelReview}
        confirmReview={confirmReview}
        modalBusy={modalBusy}
        pendingReview={pendingReview}
        slug={REVIEW_MODAL_SLUG}
        updateLocaleOverride={updateLocaleOverride}
        updateLocaleSkip={updateLocaleSkip}
      />
    </>
  )
}
