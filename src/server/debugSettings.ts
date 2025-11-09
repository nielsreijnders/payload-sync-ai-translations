import type { Payload } from 'payload'

let debugEnabled = false

export function setDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled
}

export function isDebugEnabled(): boolean {
  return debugEnabled
}

function formatDetails(details: unknown): string {
  if (details == null) {
    return ''
  }

  if (typeof details === 'string') {
    return details
  }

  try {
    return JSON.stringify(details, null, 2)
  } catch (error) {
    const fallback = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'
    return `Unable to serialize details (${fallback}).`
  }
}

export function logDebug(
  payload: Payload | null | undefined,
  message: string,
  details?: unknown,
): void {
  if (!isDebugEnabled()) {
    return
  }

  const logger = payload?.logger?.debug ?? payload?.logger?.info
  const prefix = '[AI Translate][Debug]'

  if (details === undefined) {
    if (typeof logger === 'function') {
      logger(`${prefix} ${message}`)
    } else {
      console.debug(`${prefix} ${message}`)
    }
    return
  }

  const formatted = formatDetails(details)

  if (typeof logger === 'function') {
    logger(`${prefix} ${message}: ${formatted}`)
  } else {
    console.debug(`${prefix} ${message}: ${formatted}`)
  }
}

export function logDebugError(
  payload: Payload | null | undefined,
  message: string,
  error: unknown,
  details?: unknown,
): void {
  if (!isDebugEnabled()) {
    return
  }

  const logger = payload?.logger?.error ?? payload?.logger?.debug ?? payload?.logger?.info
  const prefix = '[AI Translate][Debug]'

  const errorMessage =
    error instanceof Error ? `${error.name}: ${error.message}` : `Unknown error: ${String(error)}`

  const payloadDetails = details === undefined ? errorMessage : { error: errorMessage, details }
  if (typeof logger === 'function') {
    logger(`${prefix} ${message}: ${formatDetails(payloadDetails)}`)
  } else {
    console.debug(`${prefix} ${message}: ${formatDetails(payloadDetails)}`)
  }
}
