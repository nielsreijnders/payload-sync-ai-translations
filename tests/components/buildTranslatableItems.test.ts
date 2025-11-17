import { describe, expect, it } from 'vitest'

import {
  buildTranslatableItems,
  collectIdentifierPaths,
} from '../../src/components/auto-translate-button/utils/buildTranslatableItems.js'

describe('buildTranslatableItems', () => {
  const fieldPatterns = ['title', 'links[].label', 'links[].id']

  const data = {
    links: [
      { id: 'link-1', label: 'Home' },
      { id: 'link-2', label: 'About' },
    ],
    title: 'Navigation',
  }

  it('skips identifier fields when building items', () => {
    const items = buildTranslatableItems(data, fieldPatterns)
    const paths = items.map((item) => item.path)

    expect(paths).toEqual(['title', 'links.0.label', 'links.1.label'])
  })

  it('collects identifier paths separately for preservation', () => {
    const identifiers = collectIdentifierPaths(data, fieldPatterns)

    expect(identifiers).toEqual(['links.0.id', 'links.1.id'])
  })
})
