import type { CollectionConfig, Config, GlobalConfig } from 'payload'

import { createAiBulkTranslateHandler } from './server/bulkTranslationHandler.js'
import { setDebugEnabled } from './server/debugSettings.js'
import { createAiGrammarCheckHandler } from './server/grammarCheckHandler.js'
import { createBulkSyncLinksHandler, createSyncLinksHandler } from './server/linkSyncHandler.js'
import { setOpenAISettings } from './server/openAiSettings.js'
import { createAiTranslateHandler } from './server/translationRequestHandler.js'
import { createAiTranslateReviewHandler } from './server/translationReviewService.js'
import {
  configureTranslationState,
  listStoredCollections,
  listStoredGlobals,
} from './server/translationStateStore.js'

export type AiLocalePromptResolver = (data: unknown, locale: string) => string | undefined
export type AiLocalePromptSetting = AiLocalePromptResolver | Record<string, string> | string

export type AiLocalizationCollectionOptions = {
  clientProps?: Record<string, unknown> // add this
  customPrompt?: (data: unknown, locale: string) => string | undefined
  excludeFields?: string[]
  /**
   * Optional locale-aware prompt for grammar checks only (not used in translation flows).
   * Supports:
   * - function: (data, locale) => string
   * - object map: { 'en-us': '...', 'en-gb': '...', default: '...' }
   * - single string: applied to all locales
   */
  grammarCheckPrompt?: AiLocalePromptSetting
}

export type AiLocalizationConfig = {
  collections?: Record<string, AiLocalizationCollectionOptions>
  debug?: boolean
  globals?: Record<string, AiLocalizationCollectionOptions>
  openai: {
    apiKey: string
    model?: string
  }
  /**
   * Optional base URL for building absolute links when syncing translated alternates.
   * If omitted, the plugin falls back to Payload's `serverURL` or the incoming request.
   */
  serverURL?: string
}

const CLIENT_EXPORT = 'payload-sync-ai-translations/client#AutoTranslateButton'
const BULK_GLOBAL_COMPONENT = 'payload-sync-ai-translations/client#BulkTranslateGlobal'
const GRAMMAR_GLOBAL_COMPONENT = 'payload-sync-ai-translations/client#GrammarCheckGlobal'
const LINK_GLOBAL_COMPONENT = 'payload-sync-ai-translations/client#SyncLinksGlobal'
const BULK_GLOBAL_SLUG = 'ai-bulk-translation'
const GRAMMAR_GLOBAL_SLUG = 'grammar-check'
const LINK_GLOBAL_SLUG = 'sync-links'
const DEBUG_CLIENT_EXPORT = 'payload-sync-ai-translations/client#DebugDocumentCopyButton'
const SYNC_LINKS_CLIENT_EXPORT = 'payload-sync-ai-translations/client#DocumentSyncLinksButton'

function normalizeLocalePromptSetting(input?: AiLocalePromptSetting): AiLocalePromptResolver | undefined {
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
    .map(([key, value]) => [normalizeLocaleCode(key), typeof value === 'string' ? value.trim() : ''] as const)
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
      grammarCheckPrompt?: AiLocalePromptResolver
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
        grammarCheckPrompt: normalizeLocalePromptSetting(perColl.grammarCheckPrompt),
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

      const existingControls = global.admin?.components?.elements?.beforeDocumentControls ?? []

      return {
        ...global,
        admin: {
          ...global.admin,
          components: {
            ...global.admin?.components,
            // Try elements???
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

    configureTranslationState(trackedCollections, trackedGlobals, { defaultLocale, locales })

    const storedCollections = listStoredCollections()
    const storedGlobals = listStoredGlobals()

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
      admin: {
        group: 'Plugins',
      },
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

    const grammarGlobal: GlobalConfig = {
      slug: GRAMMAR_GLOBAL_SLUG,
      admin: {
        group: 'Plugins',
      },
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
      label: {
        plural: 'Grammar Checks',
        singular: 'Grammar Check',
      },
    }

    const linkGlobal: GlobalConfig = {
      slug: LINK_GLOBAL_SLUG,
      admin: {
        group: 'Plugins',
      },
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
      ? [...existingGlobals, bulkGlobal, grammarGlobal, linkGlobal]
      : existingGlobals

    return {
      ...config,
      collections,
      endpoints: [
        ...(config.endpoints ?? []),
        { handler: createAiBulkTranslateHandler(), method: 'post', path: '/ai-translate/bulk' },
        { handler: createAiGrammarCheckHandler(), method: 'post', path: '/ai-grammar/bulk' },
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
      ],
      globals: enhancedGlobals,
    }
  }
