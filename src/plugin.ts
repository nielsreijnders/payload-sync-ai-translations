import type { CollectionConfig, Config, GlobalConfig } from 'payload'

import { createAiBulkTranslateHandler } from './server/bulkTranslationHandler.js'
import { createBulkSyncLinksHandler, createSyncLinksHandler } from './server/linkSyncHandler.js'
import { setDebugEnabled } from './server/debugSettings.js'
import { setOpenAISettings } from './server/openAiSettings.js'
import { createAiTranslateHandler } from './server/translationRequestHandler.js'
import { createAiTranslateReviewHandler } from './server/translationReviewService.js'
import { configureTranslationState, listStoredCollections } from './server/translationStateStore.js'

export type AiLocalizationCollectionOptions = {
  clientProps?: Record<string, unknown> // add this
  excludeFields?: string[]
  customPrompt?: (data: unknown, locale: string) => string | undefined
}

export type AiLocalizationConfig = {
  collections?: Record<string, AiLocalizationCollectionOptions>
  globals?: Record<string, AiLocalizationCollectionOptions>
  debug?: boolean
  openai: {
    apiKey: string
    model?: string
  }
}

const CLIENT_EXPORT = 'payload-sync-ai-translations/client#AutoTranslateButton'
const BULK_GLOBAL_COMPONENT = 'payload-sync-ai-translations/client#BulkTranslateGlobal'
const LINK_GLOBAL_COMPONENT = 'payload-sync-ai-translations/client#SyncLinksGlobal'
const BULK_GLOBAL_SLUG = 'ai-bulk-translation'
const LINK_GLOBAL_SLUG = 'sync-links'
const DEBUG_CLIENT_EXPORT = 'payload-sync-ai-translations/client#DebugDocumentCopyButton'
const SYNC_LINKS_CLIENT_EXPORT = 'payload-sync-ai-translations/client#DocumentSyncLinksButton'

export const payloadSyncAiTranslations =
  (options: AiLocalizationConfig) =>
  (config: Config): Config => {
    const collectionSlugs = Object.keys(options.collections ?? {})
    const globalSlugs = Object.keys(options.globals ?? {})

    if (!collectionSlugs.length && !globalSlugs.length) {
      throw new Error('AI Localization: configure at least one collection or global.')
    }
    if (!options.openai?.apiKey) {
      throw new Error('AI Localization: missing OpenAI API key.')
    }
    if (!config.localization) {
      throw new Error('AI Localization requires Payload localization to be enabled.')
    }

    setOpenAISettings(options.openai)
    setDebugEnabled(Boolean(options.debug))

    const { defaultLocale, locales = [] } = config.localization

    const localeCodes = locales
      .map((locale) => (typeof locale === 'string' ? locale : locale.code))
      .filter((value): value is string => Boolean(value))

    const trackedCollections: Array<{
      config: CollectionConfig
      customPrompt?: AiLocalizationCollectionOptions['customPrompt']
      excludeFields?: string[]
    }> = []

    const trackedGlobals: Array<{
      config: GlobalConfig
      customPrompt?: AiLocalizationCollectionOptions['customPrompt']
      excludeFields?: string[]
    }> = []

    const collections = (config.collections ?? []).map((collection) => {
      const perColl = options.collections?.[collection.slug]
      if (!perColl) {
        return collection
      }

      trackedCollections.push({
        config: collection,
        customPrompt: perColl.customPrompt,
        excludeFields: perColl.excludeFields,
      })

      // Merge any user-supplied clientProps with helpful defaults
      const clientProps = {
        // your defaults coming from Payload localization config:
        defaultLocale,
        locales,
        // user-provided overrides / extras:
        ...(perColl.clientProps ?? {}),
      }

      const debugControls = options.debug
        ? [
            {
              clientProps,
              path: DEBUG_CLIENT_EXPORT,
            },
          ]
        : []

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
                ...debugControls,
                {
                  clientProps, // <-- the key bit
                  path: CLIENT_EXPORT,
                },
                {
                  clientProps,
                  path: SYNC_LINKS_CLIENT_EXPORT,
                },
              ],
            },
          },
        },
      } satisfies CollectionConfig
    })

    const globals = (config.globals ?? []).map((global) => {
      const perGlobal = options.globals?.[global.slug]
      if (!perGlobal) {
        return global
      }

      trackedGlobals.push({
        config: global,
        customPrompt: perGlobal.customPrompt,
        excludeFields: perGlobal.excludeFields,
      })

      const clientProps = {
        defaultLocale,
        locales,
        ...(perGlobal.clientProps ?? {}),
      }

      const debugControls = options.debug
        ? [
            {
              clientProps,
              path: DEBUG_CLIENT_EXPORT,
            },
          ]
        : []

      return {
        ...global,
        admin: {
          ...global.admin,
          components: {
            ...global.admin?.components,
            edit: {
              ...global.admin?.components?.edit,
              beforeDocumentControls: [
                ...(global.admin?.components?.edit?.beforeDocumentControls ?? []),
                ...debugControls,
                {
                  clientProps,
                  path: CLIENT_EXPORT,
                },
                {
                  clientProps,
                  path: SYNC_LINKS_CLIENT_EXPORT,
                },
              ],
            },
          },
        },
      } satisfies GlobalConfig
    })

    configureTranslationState(trackedCollections, trackedGlobals, { defaultLocale, locales })

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

    const linkGlobal: GlobalConfig = {
      slug: LINK_GLOBAL_SLUG,
      fields: [
        {
          name: 'syncLinks',
          type: 'ui',
          admin: {
            components: {
              Field: {
                clientProps: {
                  collections: bulkClientProps.collections,
                },
                path: LINK_GLOBAL_COMPONENT,
              },
            },
          },
        },
      ],
      label: {
        plural: 'Sync Links',
        singular: 'Sync Links',
      },
    }

    const existingGlobals = globals ?? config.globals ?? []
    const enhancedGlobals = storedCollections.length
      ? [...existingGlobals, bulkGlobal, linkGlobal]
      : existingGlobals

    return {
      ...config,
      collections,
      endpoints: [
        ...(config.endpoints ?? []),
        { handler: createAiBulkTranslateHandler(), method: 'post', path: '/ai-translate/bulk' },
        { handler: createAiTranslateHandler(), method: 'post', path: '/ai-translate' },
        { handler: createAiTranslateReviewHandler(), method: 'post', path: '/ai-translate/review' },
        { handler: createSyncLinksHandler(), method: 'post', path: '/ai-links/sync' },
        { handler: createBulkSyncLinksHandler(), method: 'post', path: '/ai-links/bulk' },
      ],
      globals: enhancedGlobals,
    }
  }
