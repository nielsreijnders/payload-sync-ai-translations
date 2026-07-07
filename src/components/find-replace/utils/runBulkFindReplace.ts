import type {
  BulkGrammarApplyTarget,
  BulkStreamEvent,
} from '../../../server/translationTypes.js'

import { postBulkStream } from '../../shared/streamBulkEvents.js'

export type BulkFindReplaceOptions = {
  apply: boolean
  applyTargets?: BulkGrammarApplyTarget[]
  caseSensitive: boolean
  find: string
  locale: string
  replace: string
  wholeWord: boolean
}

export async function runBulkFindReplace(
  targets: { collections: string[]; globals: string[] },
  options: BulkFindReplaceOptions,
  callbacks: { onEvent(event: BulkStreamEvent): void },
): Promise<void> {
  await postBulkStream(
    '/api/ai-text/find-replace',
    {
      apply: options.apply,
      applyTargets: options.applyTargets,
      caseSensitive: options.caseSensitive,
      collections: targets.collections,
      find: options.find,
      globals: targets.globals,
      locale: options.locale,
      replace: options.replace,
      wholeWord: options.wholeWord,
    },
    callbacks.onEvent,
    'Find & replace request failed.',
  )
}
