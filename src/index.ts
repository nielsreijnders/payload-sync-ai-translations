export type {
  AiLocalizationCollectionOptions,
  AiLocalizationConfig,
  AiSeoCollectionOptions,
  PayloadSyncAiTranslationsPlugin,
} from './plugin.js'
export { payloadSyncAiTranslations } from './plugin.js'

export type { SeoScanDocument, SeoScoreStatus } from './server/seoTypes.js'
export { streamTranslations } from './server/translationStream.js'
export type {
  TranslateChunk,
  TranslateDoneEvent,
  TranslateErrorEvent,
  TranslateItem,
  TranslateRequestPayload,
  TranslateStreamEvent,
} from './server/translationTypes.js'
