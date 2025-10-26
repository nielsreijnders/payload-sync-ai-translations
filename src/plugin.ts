import type { CollectionConfig, Config, GlobalConfig } from 'payload'

import { createAiBulkTranslateHandler } from './server/bulk.js'
import { createAiTranslateHandler } from './server/handler.js'
import { createAiTranslateReviewHandler } from './server/review.js'
import { setOpenAISettings } from './server/settings.js'
import { configureTranslationState, listStoredCollections } from './server/state.js'

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
const BULK_GLOBAL_COMPONENT = 'payload-sync-ai-translations/client#BulkTranslateGlobal'
const BULK_GLOBAL_SLUG = 'ai-bulk-translation'

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

    const localeCodes = locales
      .map((locale) => (typeof locale === 'string' ? locale : locale.code))
      .filter((value): value is string => Boolean(value))

    const trackedCollections: Array<{ config: CollectionConfig; excludeFields?: string[] }> = []

    const collections = (config.collections ?? []).map((collection) => {
      const perColl = options.collections[collection.slug]
      if (!perColl) {
        return collection
      }

      trackedCollections.push({ config: collection, excludeFields: perColl.excludeFields })

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

    configureTranslationState(trackedCollections, { defaultLocale, locales })

    const storedCollections = listStoredCollections()

    const bulkClientProps = {
      collections: storedCollections.map((entry) => ({
        slug: entry.slug,
        label: entry.label,
      })),
      defaultLocale,
      locales: localeCodes,
    }

    const bulkGlobal: GlobalConfig = {
      slug: BULK_GLOBAL_SLUG,
      fields: [
        {
          name: 'bulkTranslate',
          type: 'ui',
          admin: {
            components: {
              Field: {
                clientProps: bulkClientProps,
                path: BULK_GLOBAL_COMPONENT,
              },
            },
          },
        },
      ],
      label: {
        plural: 'AI Bulk Translations',
        singular: 'AI Bulk Translation',
      },
    }

    const existingGlobals = config.globals ?? []
    const globals = storedCollections.length ? [...existingGlobals, bulkGlobal] : existingGlobals

    return {
      ...config,
      collections,
      endpoints: [
        ...(config.endpoints ?? []),
        { handler: createAiBulkTranslateHandler(), method: 'post', path: '/ai-translate/bulk' },
        { handler: createAiTranslateHandler(), method: 'post', path: '/ai-translate' },
        { handler: createAiTranslateReviewHandler(), method: 'post', path: '/ai-translate/review' },
      ],
      globals,
    }
  }
