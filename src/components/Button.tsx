'use client'

import { useModal } from '@payloadcms/ui'
import { Sparkles } from 'lucide-react'
import * as React from 'react'

import type { AutoTranslateButtonProps } from './auto-translate-button/hooks/types.js'

import { useAutoTranslateButton } from './auto-translate-button/hooks/useAutoTranslateButton.js'
import { AutoTranslateReviewModal, REVIEW_MODAL_SLUG } from './Modal.js'
import { IconTooltipButton } from './shared/IconTooltipButton.js'

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
      <IconTooltipButton
        disabled={disabled}
        icon={<Sparkles size={18} strokeWidth={1.5} />}
        label="Sync translations"
        onClick={handleClick}
      />
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
