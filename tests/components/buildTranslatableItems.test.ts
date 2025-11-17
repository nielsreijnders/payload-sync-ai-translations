import { describe, expect, it } from 'vitest'

import {
  buildTranslatableItems,
  collectIdentifierPaths,
} from '../../src/components/auto-translate-button/utils/buildTranslatableItems.js'

describe('buildTranslatableItems', () => {
  const fieldPatterns = ['title', 'links[].label']

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

  it('automatically collects identifier paths for localized arrays', () => {
    const identifiers = collectIdentifierPaths(data, fieldPatterns)

    expect(identifiers).toEqual(['links.0.id', 'links.1.id'])
  })

  it('includes deeply nested identifiers when present', () => {
    const nestedPatterns = ['sections[].links[].label']
    const nestedData = {
      sections: [
        {
          _id: 'section-1',
          links: [
            { _id: 'link-1', id: 'generated-link', label: 'Docs' },
            { label: 'Community' },
          ],
        },
      ],
    }

    const identifiers = collectIdentifierPaths(nestedData, nestedPatterns)

    expect(identifiers).toEqual(['sections.0._id', 'sections.0.links.0.id', 'sections.0.links.0._id'])
  })
})
