import type { CollectionConfig, Config } from 'payload'

import { createBulkTranslateHandler } from './server/bulk.js'
import { createAiTranslateHandler } from './server/handler.js'
import { createAiTranslateReviewHandler } from './server/review.js'
import { type CollectionRuntimeConfig, setCollectionOptionsMap } from './server/runtimeConfig.js'
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
const BULK_CLIENT_EXPORT = 'payload-sync-ai-translations/client#BulkTranslationManager'

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

    const runtimeCollections: Record<string, CollectionRuntimeConfig> = {}

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

      const label =
        collection.labels?.plural ||
        collection.labels?.singular ||
        (typeof collection.label === 'string' ? collection.label : undefined) ||
        collection.slug

      runtimeCollections[collection.slug] = {
        label,
        options: perColl,
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

    setCollectionOptionsMap(runtimeCollections)

    const availableCollectionOptions = Object.entries(runtimeCollections).map(
      ([slug, info]) => ({
        label: info.label,
        value: slug,
      }),
    )

    const localeCodes = locales
      .map((locale) => {
        if (typeof locale === 'string') {
          return locale
        }
        if (typeof locale === 'object' && locale !== null) {
          const code = (locale as { code?: unknown }).code
          if (typeof code === 'string') {
            return code
          }
        }
        return null
      })
      .filter((entry): entry is string => Boolean(entry))

    const globals = [...(config.globals ?? [])]

    if (availableCollectionOptions.length) {
      globals.push({
        slug: 'ai-bulk-translations',
        fields: [
          {
            name: 'selectedCollections',
            type: 'json',
            admin: {
              components: {
                Field: BULK_CLIENT_EXPORT,
              },
              props: {
                defaultLocale,
                locales: localeCodes,
                options: availableCollectionOptions,
              },
            },
            defaultValue: [],
            description: 'Select collections to include when running an AI bulk translation job.',
            label: 'Bulk translation collections',
          },
        ],
        label: 'AI Bulk Translations',
      })
    }

    return {
      ...config,
      collections,
      endpoints: [
        ...(config.endpoints ?? []),
        { handler: createAiTranslateHandler(), method: 'post', path: '/ai-translate' },
        { handler: createAiTranslateReviewHandler(), method: 'post', path: '/ai-translate/review' },
        { handler: createBulkTranslateHandler(), method: 'post', path: '/ai-translate/bulk' },
      ],
      globals,
    }
  }
