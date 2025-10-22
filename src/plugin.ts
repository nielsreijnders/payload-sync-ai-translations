import type { CollectionConfig, Config, SanitizedConfig } from 'payload'

import type { AutoTranslateButtonProps } from './components/auto-translate-button/hooks/useAutoTranslateButton.js'

import { createAiTranslateHandler } from './server/handler.js'
import { createAiTranslateReviewHandler } from './server/review.js'
import { setOpenAISettings } from './server/settings.js'

type PayloadLocalizationConfig = Exclude<Config['localization'], false>
type PayloadSanitizedLocalizationConfig = Exclude<SanitizedConfig['localization'], false>
type SupportedLocalizationConfig = PayloadLocalizationConfig | PayloadSanitizedLocalizationConfig

function extractLocaleCodes(localization: SupportedLocalizationConfig): string[] {
  if ('localeCodes' in localization && Array.isArray(localization.localeCodes)) {
    return localization.localeCodes.filter((locale): locale is string => typeof locale === 'string' && locale.length > 0)
  }

  const locales = localization.locales ?? []

  return locales
    .map((locale) => {
      if (typeof locale === 'string') {
        return locale
      }

      if (locale && typeof locale === 'object') {
        if ('code' in locale) {
          const { code } = locale as { code?: unknown }
          if (typeof code === 'string' && code.length > 0) {
            return code
          }
        }

        if ('value' in locale) {
          const { value } = locale as { value?: unknown }
          if (typeof value === 'string' && value.length > 0) {
            return value
          }
        }
      }

      return null
    })
    .filter((locale): locale is string => typeof locale === 'string' && locale.length > 0)
}

export type AiLocalizationCollectionOptions = {
  clientProps?: null | (Partial<AutoTranslateButtonProps> & Record<string, unknown>)
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

    const localization = config.localization
    const { defaultLocale } = localization
    const localeCodes = extractLocaleCodes(localization)
    const normalizedLocaleCodes =
      typeof defaultLocale === 'string' && defaultLocale.length
        ? [defaultLocale, ...localeCodes.filter((code) => code !== defaultLocale)]
        : localeCodes

    const collections = (config.collections ?? []).map((collection) => {
      const perColl = options.collections[collection.slug]
      if (!perColl) {
        return collection
      }

      // Merge any user-supplied clientProps with helpful defaults
      const clientProps: AutoTranslateButtonProps & Record<string, unknown> = {
        // your defaults coming from Payload localization config:
        defaultLocale,
        locales: normalizedLocaleCodes,
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
