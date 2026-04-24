import type { Payload } from 'payload'

let debugEnabled = false

export function setDebugEnabled(next: boolean): void {
  debugEnabled = Boolean(next)
}

export function isDebugEnabled(): boolean {
  return debugEnabled
}

type LoggerSource =
  | Payload
  | {
      logger?: Payload['logger']
    }
  | null
  | undefined

export function logDebug(source: LoggerSource, message: string, details?: unknown): void {
  if (!debugEnabled) {
    return
  }

  const logger = (source as Payload | undefined)?.logger ?? (source as { logger?: Payload['logger'] })?.logger

  if (logger?.debug) {
    if (details !== undefined) {
      logger.debug({ details }, message)
    } else {
      logger.debug(message)
    }
    return
  }

  const prefix = '[AI Debug]'
  if (details !== undefined) {
    console.debug(prefix, message, details)
  } else {
    console.debug(prefix, message)
  }
}
