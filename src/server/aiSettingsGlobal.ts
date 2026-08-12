import type { Payload } from 'payload'

import { getOpenAISettings, type OpenAIFeatureModels } from './openAiSettings.js'

export const AI_SETTINGS_GLOBAL_SLUG = 'ai-translation-settings'

const FEATURES = ['proofread', 'review', 'translate'] as const

function normalizeModel(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed || undefined
}

/**
 * Resolves the model per AI feature: admin panel override first, then the
 * per-feature plugin config. Features that resolve to undefined fall back to
 * the base `model` (and env/default) inside the OpenAI client.
 */
export async function resolveFeatureModels(payload: Payload): Promise<OpenAIFeatureModels> {
  const configModels = getOpenAISettings()?.models
  let storedModels: Record<string, unknown> = {}

  try {
    const doc = await payload.findGlobal({ slug: AI_SETTINGS_GLOBAL_SLUG, depth: 0 })
    const models = (doc as { models?: unknown } | null)?.models
    if (models && typeof models === 'object' && !Array.isArray(models)) {
      storedModels = models as Record<string, unknown>
    }
  } catch {
    // Settings global unavailable (not registered or DB error) — use the plugin config.
  }

  const resolved: OpenAIFeatureModels = {}

  for (const feature of FEATURES) {
    resolved[feature] = normalizeModel(storedModels[feature]) ?? normalizeModel(configModels?.[feature])
  }

  return resolved
}
