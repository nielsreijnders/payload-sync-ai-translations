export type OpenAISettings = {
  apiKey: string
  model?: string
}

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
    model: process.env.OPENAI_TRANSLATE_MODEL,
  }
}
