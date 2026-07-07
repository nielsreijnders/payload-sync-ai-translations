import type { CollectionConfig, Config, GlobalConfig, PayloadTypes } from 'payload'

import { createAiBulkTranslateHandler } from './server/bulkTranslationHandler.js'
import { setDebugEnabled } from './server/debugSettings.js'
import { createFindReplaceHandler } from './server/findReplaceHandler.js'
import { createAiGrammarCheckHandler } from './server/grammarCheckHandler.js'
import { createBulkSyncLinksHandler, createSyncLinksHandler } from './server/linkSyncHandler.js'
import { setOpenAISettings } from './server/openAiSettings.js'
import { createSeoScanHandler, createSeoUpdateHandler } from './server/seoHandler.js'
import { configureSeoState, listSeoCollections } from './server/seoState.js'
import {
  createSyncStatusDocumentHandler,
  createSyncStatusScanHandler,
} from './server/syncStatusHandler.js'
import { createSyncStatusCollection } from './server/syncStatusStore.js'
import { createAiTranslateHandler } from './server/translationRequestHandler.js'
import { createAiTranslateReviewHandler } from './server/translationReviewService.js'
import {
  configureTranslationState,
  extractFieldPatterns,
  listStoredCollections,
  listStoredGlobals,
} from './server/translationStateStore.js'

type DefaultPayloadTypes = PayloadTypes
type NoInferPayloadTypes<T> = [T][T extends unknown ? 0 : never]
type SlugKey<T> = Extract<keyof T, string>
type CollectionDataBySlug<TPayloadConfig> = TPayloadConfig extends {
  collections: infer TCollections
}
  ? TCollections
  : Record<string, unknown>
type GlobalDataBySlug<TPayloadConfig> = TPayloadConfig extends { globals: infer TGlobals }
  ? TGlobals
  : Record<string, unknown>

type OptionsBySlug<TDataBySlug> = [SlugKey<TDataBySlug>] extends [never]
  ? Record<string, AiLocalizationCollectionOptions>
  : string extends SlugKey<TDataBySlug>
    ? Record<string, AiLocalizationCollectionOptions>
    : Partial<{
        [TSlug in SlugKey<TDataBySlug>]: AiLocalizationCollectionOptions<TDataBySlug[TSlug]>
      }>

export type AiLocalePromptResolver<TData = unknown> = (
  data: TData,
  locale: string,
) => string | undefined
export type AiLocalePromptSetting<TData = unknown> =
  | AiLocalePromptResolver<TData>
  | Record<string, string>
  | string

export type AiLocalizationCollectionOptions<TData = unknown> = {
  clientProps?: Record<string, unknown>
  customPrompt?: AiLocalePromptResolver<TData>
  excludeFields?: string[]
  /**
   * Optional locale-aware prompt for grammar checks only (not used in translation flows).
   * Supports:
   * - function: (data, locale) => string
   * - object map: { 'en-us': '...', 'en-gb': '...', default: '...' }
   * - single string: applied to all locales
   */
  grammarCheckPrompt?: AiLocalePromptSetting<TData>
  /**
   * Enable the SEO overview for this collection. Defaults target the official
   * Payload SEO plugin fields at `meta.title` and `meta.description`.
   */
  seo?: AiSeoCollectionOptions | boolean
}

export type AiSeoCollectionOptions = {
  /**
   * Optional document field paths used to calculate content quality.
   * If omitted, textual document content is detected automatically.
   */
  contentFields?: string[]
  descriptionPath?: string
  labelPath?: string
  slugPath?: string
  titlePath?: string
}

export type AiLocalizationConfig<TPayloadConfig = DefaultPayloadTypes> = {
  collections?: OptionsBySlug<CollectionDataBySlug<TPayloadConfig>>
  debug?: boolean
  globals?: OptionsBySlug<GlobalDataBySlug<TPayloadConfig>>
  openai: {
    apiKey: string
    baseURL?: string
    model?: string
  }
  /**
   * Optional base URL for building absolute links when syncing translated alternates.
   * If omitted, the plugin falls back to Payload's `serverURL` or the incoming request.
   */
  serverURL?: string
}

export type PayloadSyncAiTranslationsPlugin = <TPayloadConfig = DefaultPayloadTypes>(
  options: AiLocalizationConfig<NoInferPayloadTypes<TPayloadConfig>>,
) => (config: Config) => Config

const CLIENT_EXPORT = 'payload-sync-ai-translations/client#AutoTranslateButton'
const HIDDEN_SAVE_BUTTON = 'payload-sync-ai-translations/client#HiddenSaveButton'
const BULK_GLOBAL_COMPONENT = 'payload-sync-ai-translations/client#BulkTranslateGlobal'
const FIND_REPLACE_GLOBAL_COMPONENT = 'payload-sync-ai-translations/client#FindReplaceGlobal'
const GRAMMAR_GLOBAL_COMPONENT = 'payload-sync-ai-translations/client#GrammarCheckGlobal'
const LINK_GLOBAL_COMPONENT = 'payload-sync-ai-translations/client#SyncLinksGlobal'
const SEO_GLOBAL_COMPONENT = 'payload-sync-ai-translations/client#SeoOverviewGlobal'
const SYNC_STATUS_GLOBAL_COMPONENT = 'payload-sync-ai-translations/client#TranslationStatusGlobal'
const BULK_GLOBAL_SLUG = 'ai-bulk-translation'
const FIND_REPLACE_GLOBAL_SLUG = 'find-replace'
const GRAMMAR_GLOBAL_SLUG = 'grammar-check'
const LINK_GLOBAL_SLUG = 'sync-links'
const SEO_GLOBAL_SLUG = 'seo-overview'
const SYNC_STATUS_GLOBAL_SLUG = 'translation-status'
const DEBUG_CLIENT_EXPORT = 'payload-sync-ai-translations/client#DebugDocumentCopyButton'
const SYNC_LINKS_CLIENT_EXPORT = 'payload-sync-ai-translations/client#DocumentSyncLinksButton'

function normalizeLocalePromptSetting<TData = unknown>(
  input?: AiLocalePromptSetting<TData>,
): AiLocalePromptResolver<TData> | undefined {
  if (!input) {
    return undefined
  }

  const normalizeLocaleCode = (value: string) => value.trim().toLowerCase().replace(/_/g, '-')

  if (typeof input === 'function') {
    return input
  }

  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed) {
      return undefined
    }

    return () => trimmed
  }

  if (typeof input !== 'object') {
    return undefined
  }

  const entries = Object.entries(input)
    .map(
      ([key, value]) =>
        [normalizeLocaleCode(key), typeof value === 'string' ? value.trim() : ''] as const,
    )
    .filter(([key, value]) => Boolean(key) && Boolean(value))

  if (!entries.length) {
    return undefined
  }

  const map = new Map(entries)

  return (_data, locale) => {
    const normalizedLocale = normalizeLocaleCode(locale)
    const baseLocale = normalizedLocale.split('-')[0] || normalizedLocale

    return (
      map.get(normalizedLocale) ??
      map.get(baseLocale) ??
      map.get('default') ??
      map.get('*') ??
      undefined
    )
  }
}

export const payloadSyncAiTranslations: PayloadSyncAiTranslationsPlugin =
  (options) =>
  (config: Config): Config => {
    const collectionOptions = options.collections as
      | Record<string, AiLocalizationCollectionOptions>
      | undefined
    const globalOptions = options.globals as
      | Record<string, AiLocalizationCollectionOptions>
      | undefined
    const collectionSlugs = Object.keys(collectionOptions ?? {})
    const globalSlugs = Object.keys(globalOptions ?? {})

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
    const availableBlocks = config.blocks ?? []

    const localeCodes = locales
      .map((locale) => (typeof locale === 'string' ? locale : locale.code))
      .filter((value): value is string => Boolean(value))

    const trackedCollections: Array<{
      config: CollectionConfig
      customPrompt?: AiLocalizationCollectionOptions['customPrompt']
      excludeFields?: string[]
      grammarCheckPrompt?: AiLocalePromptResolver
    }> = []

    const trackedGlobals: Array<{
      config: GlobalConfig
      customPrompt?: AiLocalizationCollectionOptions['customPrompt']
      excludeFields?: string[]
    }> = []
    const seoCollections: Array<{
      config: CollectionConfig
      options: AiSeoCollectionOptions | boolean
    }> = []

    const collections = (config.collections ?? []).map((collection) => {
      const perColl = collectionOptions?.[collection.slug]
      if (!perColl) {
        return collection
      }

      trackedCollections.push({
        config: collection,
        customPrompt: perColl.customPrompt,
        excludeFields: perColl.excludeFields,
        grammarCheckPrompt: normalizeLocalePromptSetting(perColl.grammarCheckPrompt),
      })

      if (perColl.seo) {
        seoCollections.push({
          config: collection,
          options: perColl.seo,
        })
      }

      // Merge any user-supplied clientProps with helpful defaults
      const fieldPatterns = extractFieldPatterns(collection, {
        availableBlocks,
        exclude: perColl.excludeFields,
      })

      const clientProps = {
        // your defaults coming from Payload localization config:
        defaultLocale,
        fieldPatterns,
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
      const perGlobal = globalOptions?.[global.slug]
      if (!perGlobal) {
        return global
      }

      trackedGlobals.push({
        config: global,
        customPrompt: perGlobal.customPrompt,
        excludeFields: perGlobal.excludeFields,
      })

      const fieldPatterns = extractFieldPatterns(global, {
        availableBlocks,
        exclude: perGlobal.excludeFields,
      })

      const clientProps = {
        defaultLocale,
        fieldPatterns,
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

      const existingControls = global.admin?.components?.elements?.beforeDocumentControls ?? []

      return {
        ...global,
        admin: {
          ...global.admin,
          components: {
            ...global.admin?.components,
            elements: {
              ...global.admin?.components?.elements,
              beforeDocumentControls: [
                ...existingControls,
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

    configureTranslationState(
      trackedCollections,
      trackedGlobals,
      { defaultLocale, locales },
      { availableBlocks },
    )
    configureSeoState(seoCollections, { defaultLocale, locales })

    const storedCollections = listStoredCollections()
    const storedGlobals = listStoredGlobals()
    const storedSeoCollections = listSeoCollections()

    const bulkClientProps = {
      collections: storedCollections.map((entry) => ({
        slug: entry.slug,
        label: entry.label,
      })),
      defaultLocale,
      locales: localeCodes,
    }

    // The tool globals never save data through the document form, so the
    // default Save button and API tab would only distract.
    const toolGlobalAdmin: GlobalConfig['admin'] = {
      components: {
        elements: {
          SaveButton: HIDDEN_SAVE_BUTTON,
        },
      },
      group: 'Plugins',
      hideAPIURL: true,
    }

    const bulkGlobal: GlobalConfig = {
      slug: BULK_GLOBAL_SLUG,
      admin: toolGlobalAdmin,
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
      label: 'AI Bulk Translation',
    }

    const grammarGlobal: GlobalConfig = {
      slug: GRAMMAR_GLOBAL_SLUG,
      admin: toolGlobalAdmin,
      fields: [
        {
          name: 'grammarCheck',
          type: 'ui',
          admin: {
            components: {
              Field: {
                clientProps: {
                  collections: bulkClientProps.collections,
                  defaultLocale,
                  globals: storedGlobals.map((entry) => ({
                    slug: entry.slug,
                    label: entry.label,
                  })),
                },
                path: GRAMMAR_GLOBAL_COMPONENT,
              },
            },
          },
        },
      ],
      label: 'Grammar Check',
    }

    const findReplaceGlobal: GlobalConfig = {
      slug: FIND_REPLACE_GLOBAL_SLUG,
      admin: toolGlobalAdmin,
      fields: [
        {
          name: 'findReplace',
          type: 'ui',
          admin: {
            components: {
              Field: {
                clientProps: {
                  collections: bulkClientProps.collections,
                  defaultLocale,
                  globals: storedGlobals.map((entry) => ({
                    slug: entry.slug,
                    label: entry.label,
                  })),
                  locales: localeCodes,
                },
                path: FIND_REPLACE_GLOBAL_COMPONENT,
              },
            },
          },
        },
      ],
      label: 'Find & Replace',
    }

    const linkGlobal: GlobalConfig = {
      slug: LINK_GLOBAL_SLUG,
      admin: toolGlobalAdmin,
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
      label: 'Sync Links',
    }

    const seoGlobal: GlobalConfig = {
      slug: SEO_GLOBAL_SLUG,
      admin: toolGlobalAdmin,
      fields: [
        {
          name: 'seoOverview',
          type: 'ui',
          admin: {
            components: {
              Field: {
                clientProps: {
                  collections: storedSeoCollections.map((entry) => ({
                    slug: entry.slug,
                    label: entry.label,
                  })),
                  defaultLocale,
                  locales: localeCodes,
                },
                path: SEO_GLOBAL_COMPONENT,
              },
            },
          },
        },
      ],
      label: 'SEO Overview',
    }

    const syncStatusGlobal: GlobalConfig = {
      slug: SYNC_STATUS_GLOBAL_SLUG,
      admin: toolGlobalAdmin,
      fields: [
        {
          name: 'translationStatus',
          type: 'ui',
          admin: {
            components: {
              Field: {
                clientProps: {
                  collections: bulkClientProps.collections,
                  defaultLocale,
                  globals: storedGlobals.map((entry) => ({
                    slug: entry.slug,
                    label: entry.label,
                  })),
                  locales: localeCodes,
                },
                path: SYNC_STATUS_GLOBAL_COMPONENT,
              },
            },
          },
        },
      ],
      label: 'Translation Status',
    }

    const enhancedGlobals = [
      ...globals,
      ...(storedCollections.length || storedGlobals.length
        ? [bulkGlobal, grammarGlobal, findReplaceGlobal, linkGlobal, syncStatusGlobal]
        : []),
      ...(storedSeoCollections.length ? [seoGlobal] : []),
    ]

    return {
      ...config,
      collections: [...collections, createSyncStatusCollection()],
      endpoints: [
        ...(config.endpoints ?? []),
        { handler: createAiBulkTranslateHandler(), method: 'post', path: '/ai-translate/bulk' },
        { handler: createAiGrammarCheckHandler(), method: 'post', path: '/ai-grammar/bulk' },
        { handler: createFindReplaceHandler(), method: 'post', path: '/ai-text/find-replace' },
        { handler: createAiTranslateHandler(), method: 'post', path: '/ai-translate' },
        { handler: createAiTranslateReviewHandler(), method: 'post', path: '/ai-translate/review' },
        {
          handler: createSyncLinksHandler(options.serverURL),
          method: 'post',
          path: '/ai-links/sync',
        },
        {
          handler: createBulkSyncLinksHandler(options.serverURL),
          method: 'post',
          path: '/ai-links/bulk',
        },
        {
          handler: createSyncStatusScanHandler(),
          method: 'post',
          path: '/ai-sync-status/scan',
        },
        {
          handler: createSyncStatusDocumentHandler(),
          method: 'post',
          path: '/ai-sync-status/document',
        },
        ...(storedSeoCollections.length
          ? [
              { handler: createSeoScanHandler(), method: 'post' as const, path: '/ai-seo/scan' },
              {
                handler: createSeoUpdateHandler(),
                method: 'post' as const,
                path: '/ai-seo/update',
              },
            ]
          : []),
      ],
      globals: enhancedGlobals,
    }
  }
