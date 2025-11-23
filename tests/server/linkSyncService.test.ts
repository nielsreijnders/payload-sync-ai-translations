import { describe, expect, it, vi } from 'vitest'

import type { Payload } from 'payload'

vi.mock('../../src/server/linkAlternate.js', () => ({
  fetchAlternateLinks: vi.fn(async (url: string) => {
    const localized = url.replace('/collections/', '/nl/collections/')
    return new Map([['nl', localized]])
  }),
  selectAlternateForLocale: vi.fn(
    (alternates: Map<string, string>, locale: string) => alternates.get(locale) ?? null,
  ),
}))

vi.mock('../../src/server/linkCollector.js', () => ({
  collectLinkOccurrences: vi.fn((data: unknown) => {
    if (Array.isArray((data as any)?.__links)) {
      return (data as any).__links
    }

    return [
      { path: 'USP.custom', value: '/collections/shop-all' },
      { path: 'mainMenu.1.sublinks.0.links.0.link.custom', value: '/collections/shop-all/' },
    ]
  }),
  applyLinkOccurrence: vi.fn((_occurrence, _defaultDoc, localeData, replacement) => ({
    data: { ...(localeData as Record<string, unknown>), replaced: replacement },
    changed: true,
  })),
}))

import { synchronizeLinksForDocument } from '../../src/server/linkSyncService.js'

describe('synchronizeLinksForDocument', () => {
  it('prunes all identifier fields when syncing complex globals', async () => {
    const fieldPatterns = [
      'USP.label',
      'USP.custom',
      'USP.target',
      'mainMenu',
      'mainMenu[].link',
      'mainMenu[].link.label',
      'mainMenu[].link.custom',
      'mainMenu[].link.target',
      'mainMenu[].sublinks',
      'mainMenu[].sublinks[].chapeau',
      'mainMenu[].sublinks[].links',
      'mainMenu[].sublinks[].links[].link',
      'mainMenu[].sublinks[].links[].link.label',
      'mainMenu[].sublinks[].links[].link.custom',
      'mainMenu[].sublinks[].links[].link.target',
      'mainMenu[].sublinks[].links[].id',
      'mainMenu[].sublinks[].id',
      'mainMenu[].id',
      'secondaryMenu',
      'secondaryMenu[].link',
      'secondaryMenu[].link.label',
      'secondaryMenu[].link.custom',
      'secondaryMenu[].link.target',
      'secondaryMenu[].id',
    ]

    const globalMenu = {
      id: 'global:menu',
      USP: {
        label: 'Ordered before 4 p.m., delivered next day',
        custom: '/collections/shop-all',
        target: false,
        linkType: 'custom',
      },
      mainMenu: [
        {
          id: 'main-0',
          sublinks: 0,
          link: {
            label: 'Home',
            custom: '/',
            target: false,
            linkType: 'custom',
          },
        },
        {
          id: 'main-1',
          link: {
            label: 'Jewellery',
            custom: '/collections/shop-all/',
            target: false,
            linkType: 'custom',
          },
          sublinks: [
            {
              id: 'sublink-1-0',
              chapeau: 'By style',
              links: [
                {
                  id: 'item-1-0-5',
                  link: {
                    label: 'Shop All',
                    custom: '/collections/shop-all',
                    target: false,
                    linkType: 'custom',
                  },
                },
              ],
            },
          ],
        },
      ],
      secondaryMenu: [
        {
          id: 'secondary-0',
          link: { label: 'Contact', custom: '/contact', target: false, linkType: 'custom' },
        },
      ],
    }

    const payloadMock = {
      findGlobal: vi.fn<Payload['findGlobal']>().mockImplementation(async ({ locale }) => {
        // Return the same structure for all locales to ensure link replacement is attempted.
        return { ...globalMenu, locale }
      }),
      updateGlobal: vi.fn<Payload['updateGlobal']>(async (args) => args),
      logger: { error: vi.fn(), info: vi.fn() },
    } satisfies Partial<Payload>

    const result = await synchronizeLinksForDocument({
      defaultLocale: 'en',
      fieldPatterns,
      global: 'menu',
      payload: payloadMock as Payload,
      targetLocales: ['en', 'nl'],
    })

    expect(result.replacements).toBeGreaterThan(0)
    expect(result.updatedLocales).toContain('nl')
    expect(payloadMock.updateGlobal).toHaveBeenCalledTimes(1)
    const saved = payloadMock.updateGlobal.mock.calls.at(0)?.at(0)
    expect(saved?.data).toBeDefined()
    // Document identifiers are still stripped, but nested array identifiers are kept when the
    // field patterns include them to avoid duplicating items on save.
    expect(saved?.data?.id).toBeUndefined()
    const serialized = JSON.stringify(saved?.data ?? {})
    expect(serialized).toContain('"main-0"')
    expect(serialized).toContain('"sublink-1-0"')
    expect(serialized).toContain('"item-1-0-5"')
  })

  it('reuses existing array items when identifiers were stripped in a previous sync', async () => {
    const fieldPatterns = ['mainMenu', 'mainMenu[].link', 'mainMenu[].link.custom']

    const defaultGlobal = {
      id: 'global:menu',
      mainMenu: [
        { id: 'main-0', link: { custom: '/collections/shop-all', linkType: 'custom' } },
        { id: 'main-1', link: { custom: '/collections/gifts', linkType: 'custom' } },
      ],
    }

    const payloadMock = {
      findGlobal: vi.fn<Payload['findGlobal']>().mockImplementation(async ({ locale }) => {
        if (locale === 'en') {
          return { ...defaultGlobal, locale }
        }

        // Simulate a previously synced locale that no longer contains identifiers.
        return {
          ...defaultGlobal,
          locale,
          mainMenu: [
            { ...defaultGlobal.mainMenu[0], id: undefined },
            { ...defaultGlobal.mainMenu[1], id: undefined },
          ],
        }
      }),
      updateGlobal: vi.fn<Payload['updateGlobal']>(async (args) => args),
      logger: { error: vi.fn(), info: vi.fn() },
    } satisfies Partial<Payload>

    const result = await synchronizeLinksForDocument({
      defaultLocale: 'en',
      fieldPatterns,
      global: 'menu',
      payload: payloadMock as Payload,
      targetLocales: ['en', 'nl'],
    })

    expect(result.updatedLocales).toEqual(['nl'])
    expect(payloadMock.updateGlobal).toHaveBeenCalledTimes(1)
    const saved = payloadMock.updateGlobal.mock.calls.at(0)?.at(0)
    const savedMenu = saved?.data?.mainMenu
    expect(Array.isArray(savedMenu)).toBe(true)
    expect(savedMenu).toHaveLength(defaultGlobal.mainMenu.length)
  })

  it('updates locales when default links change even if they already contain alternates', async () => {
    const fieldPatterns = ['mainMenu', 'mainMenu[].link', 'mainMenu[].link.custom']

    const defaultGlobal = {
      id: 'global:menu',
      mainMenu: [
        { id: 'main-0', link: { custom: '/collections/new', linkType: 'custom' } },
      ],
      __links: [{ path: 'mainMenu.0.link.custom', value: '/collections/new' }],
    }

    const payloadMock = {
      findGlobal: vi.fn<Payload['findGlobal']>().mockImplementation(async ({ locale }) => {
        if (locale === 'en') {
          return { ...defaultGlobal, locale }
        }

        return {
          ...defaultGlobal,
          locale,
          mainMenu: [
            {
              ...defaultGlobal.mainMenu[0],
              link: { ...defaultGlobal.mainMenu[0].link, custom: '/nl/collections/old' },
            },
          ],
          __links: [{ path: 'mainMenu.0.link.custom', value: '/nl/collections/old' }],
        }
      }),
      updateGlobal: vi.fn<Payload['updateGlobal']>(async (args) => args),
      logger: { error: vi.fn(), info: vi.fn() },
    } satisfies Partial<Payload>

    const result = await synchronizeLinksForDocument({
      defaultLocale: 'en',
      fieldPatterns,
      global: 'menu',
      payload: payloadMock as Payload,
      targetLocales: ['en', 'nl'],
    })

    expect(result.updatedLocales).toEqual(['nl'])
    expect(result.replacements).toBeGreaterThan(0)
    expect(payloadMock.updateGlobal).toHaveBeenCalledTimes(1)
    const saved = payloadMock.updateGlobal.mock.calls.at(0)?.at(0)
    expect(saved?.data?.replaced).toBe('/nl/collections/new')
  })

  it('matches default links by normalized array path when items are reordered', async () => {
    const fieldPatterns = [
      'mainMenu',
      'mainMenu[].sublinks',
      'mainMenu[].sublinks[].link',
      'mainMenu[].sublinks[].link.custom',
    ]

    const defaultGlobal = {
      id: 'global:menu',
      mainMenu: [
        {
          id: 'main-0',
          sublinks: [
            {
              id: 'sublink-0-0',
              link: { custom: '/collections/shop-all', linkType: 'custom' },
            },
          ],
        },
        { id: 'main-1', sublinks: [] },
      ],
      __links: [
        { path: 'mainMenu.0.sublinks.0.link.custom', value: '/collections/shop-all' },
      ],
    }

    const payloadMock = {
      findGlobal: vi.fn<Payload['findGlobal']>().mockImplementation(async ({ locale }) => {
        if (locale === 'en') {
          return { ...defaultGlobal, locale }
        }

        return {
          ...defaultGlobal,
          locale,
          mainMenu: [
            {
              id: 'main-reordered',
              sublinks: [
                {
                  id: 'sublink-reordered',
                  link: { custom: '/nl/collections/old', linkType: 'custom' },
                },
              ],
            },
            ...defaultGlobal.mainMenu,
          ],
          __links: [
            { path: 'mainMenu.1.sublinks.0.link.custom', value: '/nl/collections/old' },
          ],
        }
      }),
      updateGlobal: vi.fn<Payload['updateGlobal']>(async (args) => args),
      logger: { error: vi.fn(), info: vi.fn() },
    } satisfies Partial<Payload>

    const result = await synchronizeLinksForDocument({
      defaultLocale: 'en',
      fieldPatterns,
      global: 'menu',
      payload: payloadMock as Payload,
      targetLocales: ['en', 'nl'],
    })

    expect(result.replacements).toBeGreaterThan(0)
    expect(payloadMock.updateGlobal).toHaveBeenCalledTimes(1)
    const saved = payloadMock.updateGlobal.mock.calls.at(0)?.at(0)
    expect(saved?.data?.replaced).toBe('/nl/collections/shop-all')
  })
})
