import * as React from 'react'

import { type AnyField, collectLocalizedFieldPatterns } from '../../../utils/localizedFields.js'

export function useLocalizedFieldPatterns(fields: AnyField[] | undefined): string[] {
  return React.useMemo(() => collectLocalizedFieldPatterns(fields), [fields])
}
