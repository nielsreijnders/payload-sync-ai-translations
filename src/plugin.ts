import type { CollectionConfig, Config } from 'payload'

import { createAiTranslateHandler } from './server/handler.js'
import { createAiTranslateReviewHandler } from './server/review.js'
import { setOpenAISettings } from './server/settings.js'

export type AiLocalizationCollectionOptions = {
  clientProps?: Record<string, unknown> // add this
  excludeFields?: string[]
}

export type AiLocalizationConfig = {
  collections: Record<string, AiLocalizationCollectionOptions>
  openai: {
    apiKey: string
    model?: string
  }
}

const CLIENT_EXPORT = 'payload-sync-ai-translations/client#AutoTranslateButton'

export const payloadSyncAiTranslations =
  (options: AiLocalizationConfig) =>
  (config: Config): Config => {
    const collectionSlugs = Object.keys(options.collections ?? {})
    if (!collectionSlugs.length) {
      throw new Error('AI Localization: configure at least one collection.')
    }
    if (!options.openai?.apiKey) {
      throw new Error('AI Localization: missing OpenAI API key.')
    }
    if (!config.localization) {
      throw new Error('AI Localization requires Payload localization to be enabled.')
    }

    setOpenAISettings(options.openai)

    const { defaultLocale, locales = [] } = config.localization

    const collections = (config.collections ?? []).map((collection) => {
      const perColl = options.collections[collection.slug]
      if (!perColl) {
        return collection
      }

      // Merge any user-supplied clientProps with helpful defaults
      const clientProps = {
        // your defaults coming from Payload localization config:
        defaultLocale,
        locales,
        // user-provided overrides / extras:
        ...(perColl.clientProps ?? {}),
      }

      return {
        ...collection,
        admin: {
          ...collection.admin,
          components: {
            ...collection.admin?.components,
            edit: {
              ...collection.admin?.components?.edit,
              beforeDocumentControls: [
                ...(collection.admin?.components?.edit?.beforeDocumentControls ?? []),
                {
                  clientProps, // <-- the key bit
                  path: CLIENT_EXPORT,
                },
              ],
            },
          },
        },
      } satisfies CollectionConfig
    })

    return {
      ...config,
      collections,
      endpoints: [
        ...(config.endpoints ?? []),
        { handler: createAiTranslateHandler(), method: 'post', path: '/ai-translate' },
        { handler: createAiTranslateReviewHandler(), method: 'post', path: '/ai-translate/review' },
      ],
    }
  }
