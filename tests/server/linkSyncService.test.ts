import type { Payload } from 'payload'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { generateLinkSyncPlan } from '../../src/server/linkSyncService.js'
import { configureTranslationState } from '../../src/server/translationStateStore.js'

describe('generateLinkSyncPlan', () => {
  beforeEach(() => {
    configureTranslationState(
      [
        {
          config: {
            fields: [],
            labels: { plural: 'Posts' },
            slug: 'posts',
          },
        },
        {
          config: {
            fields: [],
            labels: { plural: 'Pages' },
            slug: 'pages',
          },
        },
      ] as any,
      {
        defaultLocale: 'en',
        locales: ['en', 'nl'],
      },
    )
  })

  it('returns overrides for relative collection paths', async () => {
    const findMock = vi.fn<Payload['find']>().mockResolvedValue({
      docs: [{ id: '123' }],
    })
    const findByIdMock = vi.fn<Payload['findByID']>().mockImplementation(async ({ locale }) => {
      if (locale === 'nl') {
        return { slug: 'voorbeeld-slug' }
      }
      return { slug: 'example-slug' }
    })

    const payloadMock = {
      find: findMock,
      findByID: findByIdMock,
    } satisfies Partial<Payload>

    const plan = await generateLinkSyncPlan(payloadMock as Payload, {
      collection: 'posts',
      from: 'en',
      id: '1',
      items: [
        {
          lexical: false,
          path: 'components.0.button.url',
          text: '/posts/example-slug',
        },
      ],
      locales: ['nl'],
    })

    expect(findMock).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'posts',
        where: { slug: { equals: 'example-slug' } },
      }),
    )
    expect(findByIdMock).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'posts',
        id: '123',
        locale: 'nl',
      }),
    )
    expect(plan.locales).toEqual([
      {
        code: 'nl',
        overrides: [
          {
            index: 0,
            text: '/posts/voorbeeld-slug',
          },
        ],
      },
    ])
  })

  it('replaces locale prefix when present', async () => {
    const payloadMock = {
      find: vi.fn<Payload['find']>().mockResolvedValue({ docs: [{ id: '42' }] }),
      findByID: vi
        .fn<Payload['findByID']>()
        .mockResolvedValueOnce({ slug: 'voorbeeld-slug' })
        .mockResolvedValue({ slug: 'voorbeeld-slug' }),
    } satisfies Partial<Payload>

    const plan = await generateLinkSyncPlan(payloadMock as Payload, {
      collection: 'posts',
      from: 'en',
      id: '42',
      items: [
        { lexical: false, path: 'button.url', text: '/en/posts/example-slug' },
      ],
      locales: ['nl'],
    })

    expect(plan.locales[0]?.overrides[0]?.text).toBe('/nl/posts/voorbeeld-slug')
  })

  it('ignores non-link items and missing documents', async () => {
    const payloadMock = {
      find: vi.fn<Payload['find']>().mockResolvedValue({ docs: [] }),
      findByID: vi.fn<Payload['findByID']>().mockResolvedValue({ slug: 'ignored' }),
    } satisfies Partial<Payload>

    const plan = await generateLinkSyncPlan(payloadMock as Payload, {
      collection: 'posts',
      from: 'en',
      id: '1',
      items: [
        { lexical: true, path: 'content', text: 'Just text' },
        { lexical: false, path: 'title', text: 'Not a link' },
        { lexical: false, path: 'button.url', text: '/unknown/slug' },
      ],
      locales: ['nl'],
    })

    expect(plan.locales).toEqual([])
  })
})
