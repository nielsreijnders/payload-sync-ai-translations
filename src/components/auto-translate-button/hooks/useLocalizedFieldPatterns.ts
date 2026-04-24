import * as React from 'react'

import { type AnyField, collectLocalizedFieldPatterns } from '../../../utils/localizedFields.js'

export function useLocalizedFieldPatterns(
  fields: AnyField[] | undefined,
  providedPatterns?: string[],
): string[] {
  return React.useMemo(() => {
    if (providedPatterns) {
      return providedPatterns
    }

    return collectLocalizedFieldPatterns(fields)
  }, [fields, providedPatterns])
}
