import type { CollectionConfig, Config, GlobalConfig } from 'payload'

import { createAiBulkTranslateHandler } from './server/bulk.js'
import { createAiTranslateHandler } from './server/handler.js'
import { createAiTranslateReviewHandler } from './server/review.js'
import { setOpenAISettings } from './server/settings.js'

export type AiLocalizationCollectionOptions = {
  clientProps?: Record<string, unknown>
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
const BULK_CLIENT_EXPORT = 'payload-sync-ai-translations/client#BulkTranslateRunnerField'
const BULK_GLOBAL_SLUG = 'ai-translation-bulk'

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

    const labelBySlug: Record<string, string> = {}
    for (const collection of config.collections ?? []) {
      if (!collection?.slug) {
        continue
      }

      const label =
        collection.labels?.plural || collection.labels?.singular || collection.slug || ''
      if (label) {
        labelBySlug[collection.slug] = label
      }
    }

    const collections = (config.collections ?? []).map((collection) => {
      const perColl = options.collections[collection.slug]
      if (!perColl) {
        return collection
      }

      const clientProps = {
        defaultLocale,
        locales,
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
                  clientProps,
                  path: CLIENT_EXPORT,
                },
              ],
            },
          },
        },
      } satisfies CollectionConfig
    })

    const existingGlobals = config.globals ?? []
    const bulkGlobal: GlobalConfig = {
      slug: BULK_GLOBAL_SLUG,
      admin: {
        description: 'Configure which collections participate in bulk AI translations.',
      },
      fields: [
        {
          name: 'collections',
          type: 'select',
          admin: {
            description: 'Select the collections that should be included in bulk translations.',
          },
          hasMany: true,
          options: collectionSlugs.map((slug) => ({
            label: labelBySlug[slug] ?? slug,
            value: slug,
          })),
        },
        {
          name: 'runner',
          type: 'ui',
          admin: {
            components: {
              Field: BULK_CLIENT_EXPORT,
            },
            description: 'Run the AI translator for the selected collections.',
          },
        },
      ],
      label: 'AI Bulk Translations',
    }

    const hasBulkGlobal = existingGlobals.some((global) => global.slug === BULK_GLOBAL_SLUG)
    const globals = hasBulkGlobal
      ? existingGlobals.map((global) => (global.slug === BULK_GLOBAL_SLUG ? bulkGlobal : global))
      : [...existingGlobals, bulkGlobal]

    const sanitizedCollectionOptions = collectionSlugs.reduce<Record<string, { excludeFields?: string[] }>>(
      (acc, slug) => {
        acc[slug] = {
          excludeFields: options.collections[slug]?.excludeFields,
        }
        return acc
      },
      {},
    )

    const collectionLabels = collectionSlugs.reduce<Record<string, string>>((acc, slug) => {
      acc[slug] = labelBySlug[slug] ?? slug
      return acc
    }, {})

    return {
      ...config,
      collections,
      endpoints: [
        ...(config.endpoints ?? []),
        { handler: createAiTranslateHandler(), method: 'post', path: '/ai-translate' },
        { handler: createAiTranslateReviewHandler(), method: 'post', path: '/ai-translate/review' },
        {
          handler: createAiBulkTranslateHandler({
            bulkGlobalSlug: BULK_GLOBAL_SLUG,
            collectionLabels,
            collectionOptions: sanitizedCollectionOptions,
          }),
          method: 'post',
          path: '/ai-translate/bulk',
        },
      ],
      globals,
    }
  }
