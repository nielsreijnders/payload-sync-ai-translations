'use client'

import { Button } from '@payloadcms/ui'
import * as React from 'react'
import { createPortal } from 'react-dom'

import styles from './IconTooltipButton.module.css'

type IconTooltipButtonProps = {
  disabled?: boolean
  icon: React.ReactNode
  /**
   * Shows a small attention dot on the button, e.g. when the document has
   * changes that were not synced yet.
   */
  indicator?: boolean
  /**
   * Accessible name of the action; shown in the tooltip.
   */
  label: string
  onClick: (event: React.MouseEvent) => void
}

const SHOW_DELAY_MS = 250

/**
 * Icon-only document-control button with a floating label. The tooltip is
 * rendered through a portal because the Payload doc-controls bar scrolls
 * (`overflow: auto`) and would clip the built-in Button tooltip.
 */
export function IconTooltipButton({
  disabled,
  icon,
  indicator,
  label,
  onClick,
}: IconTooltipButtonProps) {
  const anchorRef = React.useRef<HTMLSpanElement>(null)
  const timerRef = React.useRef<number | undefined>(undefined)
  const [position, setPosition] = React.useState<{ left: number; top: number } | null>(null)

  const show = React.useCallback(() => {
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      const rect = anchorRef.current?.getBoundingClientRect()
      if (rect) {
        setPosition({ left: rect.left + rect.width / 2, top: rect.bottom })
      }
    }, SHOW_DELAY_MS)
  }, [])

  const hide = React.useCallback(() => {
    window.clearTimeout(timerRef.current)
    setPosition(null)
  }, [])

  React.useEffect(() => () => window.clearTimeout(timerRef.current), [])

  return (
    <span
      className={styles.anchor}
      onBlur={hide}
      onFocus={show}
      onPointerEnter={show}
      onPointerLeave={hide}
      ref={anchorRef}
    >
      <Button
        aria-label={label}
        buttonStyle="pill"
        disabled={disabled}
        icon={icon}
        onClick={onClick}
        type="button"
      />
      {indicator ? <span aria-hidden="true" className={styles.indicator} /> : null}
      {position
        ? createPortal(
            <span
              className={styles.tooltip}
              role="tooltip"
              style={{ left: position.left, top: position.top }}
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </span>
  )
}
