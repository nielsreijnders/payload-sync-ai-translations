import { MAX_CHARS_PER_CHUNK } from '../utils/localizedFields.js'

export type OpenAIFeatureModels = {
  proofread?: string
  review?: string
  translate?: string
}

export type OpenAISettings = {
  apiKey: string
  /**
   * Model choices offered in the AI Settings admin panel. When provided, the
   * per-feature model overrides render as select fields instead of free text.
   */
  availableModels?: string[]
  baseURL?: string
  /**
   * Maximum number of source characters bundled into a single OpenAI request.
   * Larger values mean fewer requests (and fewer repeats of the custom prompt),
   * at the cost of longer responses per request. Defaults to 6400.
   */
  maxCharsPerRequest?: number
  model?: string
  /**
   * Per-feature model overrides. Any feature left unset falls back to `model`.
   */
  models?: OpenAIFeatureModels
}

export const DEFAULT_MAX_CHARS_PER_REQUEST = MAX_CHARS_PER_CHUNK * 2

const MIN_MAX_CHARS_PER_REQUEST = 500

let settings: null | OpenAISettings = null

export function setOpenAISettings(next: OpenAISettings) {
  settings = { ...next }
}

export function getOpenAISettings(): null | OpenAISettings {
  if (settings) {
    return settings
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return null
  }

  return {
    apiKey,
    baseURL: process.env.OPENAI_ENDPOINT,
    model: process.env.OPENAI_TRANSLATE_MODEL,
  }
}

export function getMaxCharsPerRequest(): number {
  const configured = getOpenAISettings()?.maxCharsPerRequest

  if (typeof configured === 'number' && Number.isFinite(configured)) {
    return Math.max(MIN_MAX_CHARS_PER_REQUEST, Math.floor(configured))
  }

  return DEFAULT_MAX_CHARS_PER_REQUEST
}
