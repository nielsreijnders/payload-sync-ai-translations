import type { CollectionConfig, GlobalConfig, Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyReplacementToItem,
  buildFindRegex,
  buildReplacementFixes,
  createFindReplaceHandler,
} from '../../src/server/findReplaceHandler.js'
import { configureTranslationState } from '../../src/server/translationStateStore.js'

function parseEvents(body: string): any[] {
  return body
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function configureState() {
  configureTranslationState(
    [
      {
        config: {
          fields: [
            { name: 'title', type: 'text', localized: true },
            { name: 'intro', type: 'textarea', localized: true },
          ],
          labels: { plural: 'Pages', singular: 'Page' },
          slug: 'pages',
        } as CollectionConfig,
      },
    ],
    [
      {
        config: {
          slug: 'menu',
          fields: [{ name: 'heading', type: 'text', localized: true }],
          label: 'Menu',
        } as GlobalConfig,
      },
    ],
    { defaultLocale: 'en', locales: ['en', 'nl'] },
  )
}

describe('buildFindRegex / buildReplacementFixes', () => {
  it('matches case-insensitively by default and respects case sensitivity', () => {
    const insensitive = buildFindRegex('acme', { caseSensitive: false, wholeWord: false })
    expect('Say ACME twice: acme'.match(insensitive)).toHaveLength(2)

    const sensitive = buildFindRegex('acme', { caseSensitive: true, wholeWord: false })
    expect('Say ACME twice: acme'.match(sensitive)).toHaveLength(1)
  })

  it('supports whole-word matching', () => {
    const regex = buildFindRegex('acme', { caseSensitive: false, wholeWord: true })
    expect('Acme rocks'.match(regex)).toHaveLength(1)
    expect('Acmeify everything'.match(regex)).toBeNull()
    expect('Contact acme.'.match(regex)).toHaveLength(1)
  })

  it('escapes regex metacharacters and treats replacements literally', () => {
    const fixes = buildReplacementFixes(
      [{ lexical: false, path: 'title', text: 'Price is $10 (net)' }],
      '$10 (net)',
      '$12 ($&)',
      { caseSensitive: false, wholeWord: false },
    )

    expect(fixes).toHaveLength(1)
    expect(fixes[0]?.after).toBe('Price is $12 ($&)')
  })

  it('keeps lexical markers intact when replacing inside segments', () => {
    const text = '[[LEX-0]]The LEX word appears[[/LEX-0]]\n\n[[LEX-1]]No match here[[/LEX-1]]'
    const regex = buildFindRegex('LEX', { caseSensitive: true, wholeWord: true })
    const result = applyReplacementToItem({ lexical: true, path: 'body', text }, regex, 'lexicon')

    expect(result).toBe(
      '[[LEX-0]]The lexicon word appears[[/LEX-0]]\n\n[[LEX-1]]No match here[[/LEX-1]]',
    )
  })

  it('skips replacements that would blank a field', () => {
    const fixes = buildReplacementFixes(
      [{ lexical: false, path: 'title', text: 'Acme' }],
      'Acme',
      '',
      { caseSensitive: false, wholeWord: false },
    )

    expect(fixes).toHaveLength(0)
  })
})

describe('createFindReplaceHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configureState()
  })

  it('rejects unauthenticated requests', async () => {
    const handler = createFindReplaceHandler()
    const response = await handler({
      json: async () => ({ collections: ['pages'], find: 'a', replace: 'b' }),
      payload: {},
      user: null,
    } as any)

    expect(response.status).toBe(401)
  })

  it('streams scan fixes for collections and globals in the requested locale', async () => {
    const doc = { id: '1', intro: 'Nothing to see', title: 'Acme launches Acme 2.0' }
    const globalDoc = { heading: 'Welcome to Acme' }

    const find = vi
      .fn<Payload['find']>()
      .mockResolvedValueOnce({ docs: [], hasNextPage: false, totalDocs: 1 } as any)
      .mockResolvedValueOnce({ docs: [doc], hasNextPage: false, totalDocs: 1 } as any)
    const findGlobal = vi.fn<Payload['findGlobal']>().mockResolvedValue(globalDoc as any)

    const payloadMock = {
      find,
      findGlobal,
      logger: { error: vi.fn(), info: vi.fn() },
      update: vi.fn(),
      updateGlobal: vi.fn(),
    } satisfies Partial<Payload>

    const handler = createFindReplaceHandler()
    const response = await handler({
      json: async () => ({
        collections: ['pages'],
        find: 'Acme',
        globals: ['menu'],
        locale: 'nl',
        replace: 'Contoso',
      }),
      payload: payloadMock,
      user: { id: 'user-1' },
    } as any)

    expect(response.status).toBe(200)
    const events = parseEvents(await response.text())

    expect(find).toHaveBeenCalledWith(expect.objectContaining({ locale: 'nl' }))
    expect(findGlobal).toHaveBeenCalledWith(expect.objectContaining({ locale: 'nl' }))

    const fixesEvents = events.filter((event) => event.type === 'document-fixes')
    expect(fixesEvents).toHaveLength(2)

    const collectionFixes = fixesEvents.find((event) => event.collection === 'pages')
    expect(collectionFixes.fixes).toEqual([
      {
        after: 'Contoso launches Contoso 2.0',
        before: 'Acme launches Acme 2.0',
        lexical: false,
        path: 'title',
      },
    ])

    const globalFixes = fixesEvents.find((event) => event.collection === 'global:menu')
    expect(globalFixes.global).toBe('menu')
    expect(globalFixes.fixes[0].after).toBe('Welcome to Contoso')

    // Scanning must never write.
    expect(payloadMock.update).not.toHaveBeenCalled()
    expect(payloadMock.updateGlobal).not.toHaveBeenCalled()

    const complete = events.find((event) => event.type === 'bulk-complete')
    expect(complete).toMatchObject({ failed: 0, processed: 2 })
  })

  it('applies reviewed replacements through the override pipeline', async () => {
    const doc = { id: '1', intro: 'Keep me', title: 'Acme launches' }

    const payloadMock = {
      find: vi.fn<Payload['find']>(),
      findByID: vi.fn<Payload['findByID']>().mockResolvedValue(doc as any),
      logger: { error: vi.fn(), info: vi.fn() },
      update: vi.fn<Payload['update']>(async (args) => args as any),
      updateGlobal: vi.fn(),
    } satisfies Partial<Payload>

    const handler = createFindReplaceHandler()
    const response = await handler({
      json: async () => ({
        apply: true,
        applyTargets: [
          {
            id: '1',
            collection: 'pages',
            overrides: [{ lexical: false, path: 'title', text: 'Contoso launches' }],
          },
        ],
        collections: ['pages'],
        find: 'Acme',
        replace: 'Contoso',
      }),
      payload: payloadMock,
      user: { id: 'user-1' },
    } as any)

    expect(response.status).toBe(200)
    const events = parseEvents(await response.text())

    expect(payloadMock.update).toHaveBeenCalledTimes(1)
    const updateArgs = payloadMock.update.mock.calls.at(0)?.at(0) as any
    expect(updateArgs.collection).toBe('pages')
    expect(updateArgs.locale).toBe('en')
    expect(updateArgs.data.title).toBe('Contoso launches')

    const complete = events.find((event) => event.type === 'bulk-complete')
    expect(complete).toMatchObject({ failed: 0, processed: 1 })
  })
})
