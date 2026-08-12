import type { CollectionConfig, GlobalConfig, Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createAiBulkTranslateHandler } from '../../src/server/bulkTranslationHandler.js'
import {
  openAiDetectMissingInformation,
  openAiTranslateTexts,
} from '../../src/server/openAiTranslationClient.js'
import { configureTranslationState } from '../../src/server/translationStateStore.js'

vi.mock('../../src/server/openAiTranslationClient.js', () => ({
  openAiDetectMissingInformation: vi.fn(),
  openAiTranslateTexts: vi.fn(),
  shouldPreserveOriginalValue: vi.fn(() => false),
}))

const detectMissingInformationMock = vi.mocked(openAiDetectMissingInformation)
const translateTextsMock = vi.mocked(openAiTranslateTexts)

function parseEvents(body: string): unknown[] {
  return body
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

describe('createAiBulkTranslateHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configureTranslationState(
      [
        {
          config: {
            fields: [
              { name: 'title', type: 'text', localized: true },
              { name: 'slug', type: 'text', localized: true },
              { name: 'singularSlug', type: 'text', localized: true },
              {
                name: 'seo',
                type: 'group',
                fields: [
                  { name: 'title', type: 'text', localized: true },
                  { name: 'slug', type: 'text', localized: true },
                ],
              },
            ],
            labels: { plural: 'Pages', singular: 'Page' },
            slug: 'pages',
          } as CollectionConfig,
        },
      ],
      [
        {
          config: {
            fields: [
              { name: 'tagline', type: 'text', localized: true },
              {
                name: 'cta',
                type: 'group',
                fields: [{ name: 'label', type: 'text', localized: true }],
              },
            ],
            label: 'Site Settings',
            slug: 'site-settings',
          } as GlobalConfig,
          customPrompt: (data, locale) =>
            `Tagline: ${(data as { tagline?: string }).tagline} → ${locale}`,
        },
      ],
      { defaultLocale: 'en', locales: ['en', 'nl'] },
    )
  })

  it('overwrites all translatable fields except user-skipped fields', async () => {
    const baseDoc = {
      id: '1',
      seo: {
        slug: 'seo-home',
        title: 'SEO homepage',
      },
      singularSlug: 'page',
      slug: 'home',
      title: 'Homepage',
    }
    const existingLocaleDoc = {
      id: '1',
      seo: {
        title: 'Bestaande SEO titel',
      },
      singularSlug: 'pagina',
      slug: 'startpagina',
      title: 'Bestaande titel',
    }

    const payloadMock = {
      find: vi
        .fn<Payload['find']>()
        .mockResolvedValueOnce({ docs: [], hasNextPage: false, totalDocs: 1 } as any)
        .mockResolvedValueOnce({ docs: [baseDoc], hasNextPage: false, totalDocs: 1 } as any),
      findByID: vi.fn<Payload['findByID']>().mockImplementation(async ({ locale }) => {
        return locale === 'en' ? baseDoc : existingLocaleDoc
      }),
      logger: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      update: vi.fn<Payload['update']>(async (args) => args),
    } satisfies Partial<Payload>

    translateTextsMock.mockResolvedValueOnce(['Startpagina', 'SEO startpagina'])

    const handler = createAiBulkTranslateHandler()
    const response = await handler({
      json: async () => ({
        collections: ['pages'],
        overwrite: true,
        skipFields: 'slug, singularSlug',
      }),
      payload: payloadMock,
      user: { id: 'user-1' },
    } as any)

    expect(response.status).toBe(200)
    const events = parseEvents(await response.text())

    expect(detectMissingInformationMock).not.toHaveBeenCalled()
    expect(translateTextsMock).toHaveBeenCalledWith(
      ['Homepage', 'SEO homepage'],
      'en',
      'nl',
      expect.objectContaining({ customPrompt: undefined }),
    )
    expect(payloadMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'pages',
        data: { seo: { title: 'SEO startpagina' }, title: 'Startpagina' },
        id: '1',
        locale: 'nl',
        overrideAccess: true,
      }),
    )
    expect(events).toContainEqual({ collection: 'pages', id: '1', type: 'document-success' })
    expect(events).toContainEqual({ failed: 0, processed: 1, skipped: 0, type: 'bulk-complete' })
  })

  it('overwrites translations for selected globals using their custom prompt', async () => {
    const baseGlobal = {
      id: 1,
      cta: { label: 'Read more' },
      tagline: 'Welcome',
    }
    const existingNlGlobal = {
      id: 1,
      cta: { label: 'Bestaande CTA' },
      tagline: 'Bestaande tagline',
    }

    const payloadMock = {
      create: vi.fn(async (args: unknown) => args),
      find: vi.fn().mockResolvedValue({ docs: [], hasNextPage: false, totalDocs: 0 }),
      findGlobal: vi.fn().mockImplementation(async ({ locale, slug }) => {
        if (slug !== 'site-settings') {
          return {}
        }

        return locale === 'en' ? baseGlobal : existingNlGlobal
      }),
      logger: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      updateGlobal: vi.fn(async (args: unknown) => args),
    } as unknown as Payload

    translateTextsMock.mockResolvedValueOnce(['Welkom', 'Lees meer'])

    const handler = createAiBulkTranslateHandler()
    const response = await handler({
      json: async () => ({
        globals: ['site-settings'],
        overwrite: true,
      }),
      payload: payloadMock,
      user: { id: 'user-1' },
    } as any)

    expect(response.status).toBe(200)
    const events = parseEvents(await response.text())

    expect(detectMissingInformationMock).not.toHaveBeenCalled()
    expect(translateTextsMock).toHaveBeenCalledWith(
      ['Welcome', 'Read more'],
      'en',
      'nl',
      expect.objectContaining({ customPrompt: 'Tagline: Welcome → nl' }),
    )
    expect(payloadMock.updateGlobal).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'site-settings',
        data: { cta: { label: 'Lees meer' }, tagline: 'Welkom' },
        locale: 'nl',
        overrideAccess: true,
      }),
    )
    expect(events).toContainEqual({
      totalCollections: 1,
      totalDocuments: 1,
      type: 'bulk-start',
    })
    expect(events).toContainEqual({
      collection: 'global:site-settings',
      label: 'Site Settings',
      totalDocuments: 1,
      type: 'collection-start',
    })
    expect(events).toContainEqual({
      collection: 'global:site-settings',
      id: 'site-settings',
      type: 'document-success',
    })
    expect(events).toContainEqual({ failed: 0, processed: 1, skipped: 0, type: 'bulk-complete' })
  })
})
