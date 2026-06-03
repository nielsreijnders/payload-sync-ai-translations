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

  it('skips arbitrary field names without hardcoding them', () => {
    const nestedPatterns = ['title', 'slug', 'sections[].slug', 'sections[].singularSlug']
    const nestedData = {
      sections: [{ singularSlug: 'feature', slug: 'nested-feature' }],
      singularSlug: 'page',
      slug: 'home',
      title: 'Homepage',
    }

    const items = buildTranslatableItems(nestedData, nestedPatterns, {
      skipFields: ['slug', 'singularSlug'],
    })

    expect(items.map((item) => item.path)).toEqual(['title'])
  })

  it('skips arbitrary field paths across array indexes', () => {
    const nestedPatterns = ['seo.title', 'sections[].seo.title', 'sections[].title']
    const nestedData = {
      sections: [{ seo: { title: 'Nested SEO title' }, title: 'Section title' }],
      seo: { title: 'SEO title' },
    }

    const items = buildTranslatableItems(nestedData, nestedPatterns, {
      skipFields: ['sections.seo'],
    })

    expect(items.map((item) => item.path)).toEqual(['seo.title', 'sections.0.title'])
  })
})
