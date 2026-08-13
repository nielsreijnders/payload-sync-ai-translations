'use client'

import { useDocumentInfo, useModal } from '@payloadcms/ui'
import { Sparkles } from 'lucide-react'
import * as React from 'react'

import type { LocaleSyncStatus } from '../server/syncStatusTypes.js'
import type { AutoTranslateButtonProps } from './auto-translate-button/hooks/types.js'

import { useAutoTranslateButton } from './auto-translate-button/hooks/useAutoTranslateButton.js'
import { AutoTranslateReviewModal, REVIEW_MODAL_SLUG } from './Modal.js'
import { IconTooltipButton } from './shared/IconTooltipButton.js'

type SyncIndicatorState = {
  changedFields: number
  needsSync: boolean
}

/**
 * Fetches whether the current document changed since its last translation
 * sync, so the button can warn editors who forget to sync.
 */
function useSyncIndicator(): { refresh: () => void; state: null | SyncIndicatorState } {
  const { id, collectionSlug, globalSlug, lastUpdateTime } = useDocumentInfo()
  const [state, setState] = React.useState<null | SyncIndicatorState>(null)

  const refresh = React.useCallback(() => {
    if (!collectionSlug && !globalSlug) {
      return
    }
    if (collectionSlug && !id) {
      return
    }

    void (async () => {
      try {
        const response = await fetch('/api/ai-sync-status/document', {
          body: JSON.stringify({ id, collection: collectionSlug, global: globalSlug }),
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        })

        if (!response.ok) {
          return
        }

        const body = (await response.json().catch(() => null)) as {
          status?: { locales?: LocaleSyncStatus[] }
        } | null
        const locales = body?.status?.locales
        if (!Array.isArray(locales)) {
          return
        }

        setState({
          changedFields: locales.reduce(
            (max, locale) => Math.max(max, locale?.changedFields ?? 0),
            0,
          ),
          needsSync: locales.some((locale) => locale?.status && locale.status !== 'synced'),
        })
      } catch {
        // The indicator is informational only; ignore fetch failures.
      }
    })()
  }, [collectionSlug, globalSlug, id])

  // Refresh on mount and after every document save, so editing the default
  // locale immediately flags the document as out of sync.
  React.useEffect(() => {
    refresh()
  }, [refresh, lastUpdateTime])

  return { refresh, state }
}

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
  const { refresh: refreshSyncStatus, state: syncState } = useSyncIndicator()
  const hadReview = React.useRef(false)

  React.useEffect(() => {
    if (pendingReview) {
      openModal(REVIEW_MODAL_SLUG)
    } else {
      closeModal(REVIEW_MODAL_SLUG)
    }
  }, [closeModal, openModal, pendingReview])

  // Refresh the out-of-sync indicator once a review-based sync finishes.
  React.useEffect(() => {
    if (pendingReview) {
      hadReview.current = true
      return
    }

    if (hadReview.current) {
      hadReview.current = false
      refreshSyncStatus()
    }
  }, [pendingReview, refreshSyncStatus])

  const handleButtonClick = React.useCallback(async () => {
    await handleClick()
    // Covers syncs that complete without opening the review modal.
    refreshSyncStatus()
  }, [handleClick, refreshSyncStatus])

  if (!shouldRender) {
    return null
  }

  const needsSync = Boolean(syncState?.needsSync)
  const changedFields = syncState?.changedFields ?? 0
  const label = needsSync
    ? `Sync translations · ${changedFields} field${changedFields === 1 ? '' : 's'} changed since last sync`
    : 'Sync translations'

  return (
    <>
      <IconTooltipButton
        disabled={disabled}
        icon={<Sparkles size={18} strokeWidth={1.5} />}
        indicator={needsSync}
        label={label}
        onClick={() => void handleButtonClick()}
      />
      <AutoTranslateReviewModal
        cancelReview={cancelReview}
        confirmReview={confirmReview}
        defaultLocale={props.defaultLocale ?? undefined}
        modalBusy={modalBusy}
        pendingReview={pendingReview}
        slug={REVIEW_MODAL_SLUG}
        updateLocaleOverride={updateLocaleOverride}
        updateLocaleSkip={updateLocaleSkip}
      />
    </>
  )
}
