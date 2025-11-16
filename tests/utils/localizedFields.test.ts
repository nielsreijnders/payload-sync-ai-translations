import { collectLocalizedFieldPatterns, type AnyField } from '../../src/utils/localizedFields.js'
import { describe, expect, it } from 'vitest'

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

  it('includes tab names in the collected pattern when present', () => {
    const fields: AnyField[] = [
      {
        name: 'components',
        type: 'blocks',
        blocks: [
          {
            slug: 'Richtext',
            fields: [
              {
                type: 'tabs',
                tabs: [
                  {
                    name: 'content',
                    fields: [
                      {
                        name: 'richtext',
                        type: 'richText',
                        localized: true,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]

    const patterns = collectLocalizedFieldPatterns(fields)

    expect(patterns).toContain('components.Richtext.content.richtext')
  })

  it('does not collect patterns for radio fields', () => {
    const fields: AnyField[] = [
      {
        name: 'layout',
        type: 'radio',
        localized: true,
      },
    ]

    const patterns = collectLocalizedFieldPatterns(fields)

    expect(patterns).not.toContain('layout')
  })

  it('does not collect patterns for relationship fields', () => {
    const fields: AnyField[] = [
      {
        name: 'relatedPosts',
        type: 'relationship',
        localized: true,
      },
    ]

    const patterns = collectLocalizedFieldPatterns(fields)

    expect(patterns).not.toContain('relatedPosts')
  })

  it('does not collect patterns for select fields', () => {
    const fields: AnyField[] = [
      {
        name: 'status',
        type: 'select',
        localized: true,
      },
    ]

    const patterns = collectLocalizedFieldPatterns(fields)

    expect(patterns).not.toContain('status')
  })
})
