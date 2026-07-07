import type {
  BulkGrammarApplyTarget,
  BulkStreamEvent,
} from '../../../server/translationTypes.js'

import { postBulkStream } from '../../shared/streamBulkEvents.js'

export type BulkGrammarCheckCallbacks = {
  onEvent(event: BulkStreamEvent): void
}

export async function runBulkGrammarCheck(
  targets: { collections: string[]; globals: string[] },
  options: { apply: boolean; applyTargets?: BulkGrammarApplyTarget[] },
  callbacks: BulkGrammarCheckCallbacks,
): Promise<void> {
  await postBulkStream(
    '/api/ai-grammar/bulk',
    {
      apply: options.apply,
      applyTargets: options.applyTargets,
      collections: targets.collections,
      globals: targets.globals,
    },
    callbacks.onEvent,
    'Grammar check request failed.',
  )
}
