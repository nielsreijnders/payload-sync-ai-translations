import { describe, expect, it } from 'vitest'

import { applyLinkOccurrence } from '../../src/server/linkCollector.js'

describe('applyLinkOccurrence', () => {
  const occurrence = {
    type: 'string' as const,
    mode: 'string-exact' as const,
    path: 'columns.0.links.1.link.custom',
    value: '/blog',
  }

  it('matches shared array rows by id when ids line up', () => {
    const baseDoc = {
      columns: [
        {
          id: 'col-1',
          links: [
            { id: 'row-a', link: { custom: '/about' } },
            { id: 'row-b', link: { custom: '/blog' } },
          ],
        },
      ],
    }
    // Same rows, reordered in the locale doc: the id lookup must follow row-b.
    const localeData = {
      columns: [
        {
          id: 'col-1',
          links: [
            { id: 'row-b', link: { custom: '/blog' } },
            { id: 'row-a', link: { custom: '/about' } },
          ],
        },
      ],
    }

    const result = applyLinkOccurrence(occurrence, baseDoc, localeData, '/nl/blog')

    expect(result.changed).toBe(true)
  })

  it('falls back to the positional path for localized array rows with own ids', () => {
    // Rows of a LOCALIZED array exist per locale with their own ids (the
    // translator creates fresh nl rows), so the id lookup finds nothing and
    // replacements used to be silently skipped — footer links kept "/blog".
    const baseDoc = {
      columns: [
        {
          id: 'col-1',
          links: [
            { id: 'en-row-a', link: { custom: '/about' } },
            { id: 'en-row-b', link: { custom: '/blog' } },
          ],
        },
      ],
    }
    const localeData = {
      columns: [
        {
          id: 'col-1',
          links: [
            { id: 'nl-row-a', link: { custom: '/about' } },
            { id: 'nl-row-b', link: { custom: '/blog' } },
          ],
        },
      ],
    }

    const result = applyLinkOccurrence(occurrence, baseDoc, localeData, '/nl/blog')

    expect(result.changed).toBe(true)
    const data = result.data as typeof localeData
    expect(data.columns[0].links[1].link.custom).toBe('/nl/blog')
    expect(data.columns[0].links[0].link.custom).toBe('/about')
  })

  it('does not replace when the positional row holds a different value', () => {
    const baseDoc = {
      columns: [{ id: 'col-1', links: [{ id: 'en-row', link: { custom: '/blog' } }] }],
    }
    // Different ids AND a different value at the position: nothing may change.
    const localeData = {
      columns: [{ id: 'col-1', links: [{ id: 'nl-row', link: { custom: '/contact' } }] }],
    }

    const shifted = {
      ...occurrence,
      path: 'columns.0.links.0.link.custom',
    }
    const result = applyLinkOccurrence(shifted, baseDoc, localeData, '/nl/blog')

    expect(result.changed).toBe(false)
  })
})
