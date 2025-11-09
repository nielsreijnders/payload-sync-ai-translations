import { describe, expect, it } from 'vitest'

import { collectLocalizedFieldPatterns, type AnyField } from '../../src/utils/localizedFields.js'

describe('collectLocalizedFieldPatterns', () => {
  it('includes nested fields when localization is inherited from parent groups', () => {
    const fields: AnyField[] = [
      {
        name: 'components',
        type: 'blocks',
        blocks: [
          {
            slug: 'Text',
            fields: [
              {
                name: 'content',
                type: 'group',
                localized: true,
                fields: [
                  {
                    name: 'layout',
                    type: 'text',
                  },
                  {
                    name: 'content',
                    type: 'richText',
                  },
                ],
              },
            ],
          },
        ],
      },
    ]

    const patterns = collectLocalizedFieldPatterns(fields)

    expect(patterns).toContain('components.Text.content')
    expect(patterns).toContain('components.Text.content.content')
  })

  it('propagates inherited localization flags through nested structures', () => {
    const fields: AnyField[] = [
      {
        name: 'wrapper',
        type: 'group',
        localized: true,
        fields: [
          {
            name: 'items',
            type: 'array',
            fields: [
              {
                name: 'label',
                type: 'text',
              },
            ],
          },
        ],
      },
    ]

    const patterns = collectLocalizedFieldPatterns(fields)

    expect(patterns).toContain('wrapper')
    expect(patterns).toContain('wrapper.items')
    expect(patterns).toContain('wrapper.items[].label')
  })
})
