export type { AiLocalizationCollectionOptions, AiLocalizationConfig } from './plugin.js'
export { payloadSyncAiTranslations } from './plugin.js'

export { streamTranslations } from './server/stream.js'
export type {
  BulkTranslateDoneEvent,
  BulkTranslateErrorEvent,
  BulkTranslateLogEvent,
  BulkTranslateProgressEvent,
  BulkTranslateStreamEvent,
  TranslateChunk,
  TranslateDoneEvent,
  TranslateErrorEvent,
  TranslateItem,
  TranslateRequestPayload,
  TranslateStreamEvent,
} from './server/types.js'
