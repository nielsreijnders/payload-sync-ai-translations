import type { CollectionConfig, Config, GlobalConfig } from 'payload'

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
const BULK_CLIENT_EXPORT = 'payload-sync-ai-translations/client#BulkTranslateGlobal'
const BULK_GLOBAL_SLUG = 'ai-bulk-translate'

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

    const collectionLabels = new Map<string, string>()

    const collections = (config.collections ?? []).map((collection) => {
      const perColl = options.collections[collection.slug]
      if (!perColl) {
        return collection
      }

      const labels = collection.labels
      let label: string | undefined
      if (labels && typeof labels === 'object') {
        if (typeof labels.plural === 'string' && labels.plural) {
          label = labels.plural
        } else if (typeof labels.singular === 'string' && labels.singular) {
          label = labels.singular
        }
      }

      if (!label && typeof (collection as { label?: unknown }).label === 'string') {
        label = (collection as { label: string }).label
      }

      collectionLabels.set(collection.slug, label ?? collection.slug)

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

    const collectionOptions = collectionSlugs
      .map((slug) => {
        const label = collectionLabels.get(slug)
        if (!label) {
          return null
        }

        return { slug, label }
      })
      .filter((entry): entry is { label: string; slug: string } => Boolean(entry))

    const localeCodes = locales
      .map((locale) => (typeof locale === 'object' ? locale.code : locale))
      .filter((code): code is string => typeof code === 'string' && code.length > 0)

    const bulkGlobal: GlobalConfig = {
      slug: BULK_GLOBAL_SLUG,
      admin: {
        components: {
          elements: {
            beforeDocumentControls: [
              {
                clientProps: {
                  collections: collectionOptions,
                  defaultLocale,
                  locales: localeCodes,
                },
                path: BULK_CLIENT_EXPORT,
              },
            ],
          },
        },
      },
      fields: [
        {
          name: 'collections',
          type: 'select',
          admin: {
            description:
              'Select the collections that should be included when running the AI bulk translator.',
          },
          hasMany: true,
          label: 'Collections',
          options: collectionOptions.map((option) => ({ label: option.label, value: option.slug })),
        },
      ],
      label: 'AI Bulk Translation',
    }

    const existingGlobals = config.globals ?? []
    const globals = [...existingGlobals.filter((global) => global.slug !== BULK_GLOBAL_SLUG), bulkGlobal]

    return {
      ...config,
      collections,
      endpoints: [
        ...(config.endpoints ?? []),
        { handler: createAiTranslateHandler(), method: 'post', path: '/ai-translate' },
        { handler: createAiTranslateReviewHandler(), method: 'post', path: '/ai-translate/review' },
      ],
      globals,
    }
  }
