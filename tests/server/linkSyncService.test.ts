import { describe, expect, it, vi } from 'vitest'

import { synchronizeLinksForDocument } from '../../src/server/linkSyncService.js'

vi.mock('../../src/server/linkAlternate.js', () => ({
  fetchAlternateLinks: vi.fn(async () => new Map([['nl', '/nl/collections/shop-all']])),
  selectAlternateForLocale: vi.fn((alternates: Map<string, string>, locale: string) =>
    alternates.get(locale) ?? null,
  ),
}))

function containsIdentifierKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsIdentifierKey(entry))
  }

  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([key, child]) =>
      key === 'id' || key === '_id' ? true : containsIdentifierKey(child),
    )
  }

  return false
}

describe('synchronizeLinksForDocument', () => {
  it('strips identifier fields when syncing the menu global', async () => {
    const defaultLocale = 'en'
    const targetLocale = 'nl'

    const menu = {
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
          link: { label: 'Home', custom: '/', target: false, linkType: 'custom' },
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
                  id: 'item-1-0-0',
                  link: {
                    label: "autumn - winter'25 ",
                    custom: 'https://www.tweek-eek.com/collections/autumn-20winter-25',
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
          id: '68d8e868cb5fc7aee5486845',
          link: { label: 'Contact', custom: '/contact', target: false, linkType: 'custom' },
        },
      ],
    }

    const payload = {
      findGlobal: vi.fn(async ({ locale }) => menu),
      logger: { debug: vi.fn() },
      updateGlobal: vi.fn(async (args) => args),
    }

    const result = await synchronizeLinksForDocument({
      defaultLocale,
      fieldPatterns: [
        'USP.custom',
        'mainMenu[].link.custom',
        'mainMenu[].sublinks[].links[].link.custom',
        'secondaryMenu[].link.custom',
      ],
      global: 'menu',
      payload: payload as never,
      targetLocales: [defaultLocale, targetLocale],
    })

    expect(result.errors).toEqual([])
    expect(result.updatedLocales).toEqual([targetLocale])

    expect(payload.updateGlobal).toHaveBeenCalledTimes(1)
    const saveCall = payload.updateGlobal.mock.calls[0]?.[0]
    expect(saveCall?.slug).toBe('menu')
    expect(saveCall?.locale).toBe(targetLocale)
    expect(saveCall?.data).toEqual(
      expect.objectContaining({
        USP: expect.objectContaining({ custom: '/nl/collections/shop-all' }),
      }),
    )
    expect(containsIdentifierKey(saveCall?.data)).toBe(false)
  })
})
