import { describe, expect, it } from 'vitest'

import { scoreSeoDocument } from '../../src/server/seoScoring.js'
import type { StoredSeoCollection } from '../../src/server/seoState.js'

const config: StoredSeoCollection = {
  slug: 'pages',
  contentFields: ['content'],
  descriptionPath: 'meta.description',
  label: 'Pages',
  labelPath: 'title',
  slugPath: 'slug',
  titlePath: 'meta.title',
}

function lexicalContent(text: string, includeHeading: boolean) {
  return {
    root: {
      type: 'root',
      children: [
        ...(includeHeading
          ? [
              {
                type: 'heading',
                children: [{ type: 'text', text: 'Payload localization workflow guide' }],
              },
            ]
          : []),
        {
          type: 'paragraph',
          children: [{ type: 'text', text }],
        },
      ],
    },
  }
}

describe('scoreSeoDocument', () => {
  it('awards a complete score for strong metadata and structured content', () => {
    const repeatedContent = Array.from(
      { length: 310 },
      (_, index) =>
        ['payload', 'localization', 'workflow', 'guide', 'global', 'teams', `topic${index}`][
          index % 7
        ],
    ).join(' ')

    const result = scoreSeoDocument(
      {
        id: 'page-1',
        slug: 'payload-localization-workflow',
        content: lexicalContent(repeatedContent, true),
        meta: {
          description:
            'A practical guide to Payload localization workflows for global teams publishing clear, structured and searchable content.',
          title: 'Payload Localization Workflow Guide for Global Teams',
        },
        title: 'Localization workflow',
      },
      config,
      'en',
    )

    expect(result).toMatchObject({
      headingCount: 1,
      score: 100,
      status: 'good',
      wordCount: 314,
    })
    expect(result.issues).toEqual([])
  })

  it('returns actionable issues for missing metadata and thin content', () => {
    const result = scoreSeoDocument(
      {
        id: 'page-2',
        content: lexicalContent('Very short.', false),
        meta: {},
        title: 'Thin page',
      },
      config,
      'en',
    )

    expect(result.score).toBeLessThan(50)
    expect(result.status).toBe('poor')
    expect(result.issues).toEqual(
      expect.arrayContaining([
        'SEO title is missing.',
        'SEO description is missing.',
        'No heading was found in the configured content.',
      ]),
    )
  })
})
