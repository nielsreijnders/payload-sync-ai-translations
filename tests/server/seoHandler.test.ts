import type { PayloadRequest } from 'payload'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createSeoScanHandler, createSeoUpdateHandler } from '../../src/server/seoHandler.js'
import { configureSeoState } from '../../src/server/seoState.js'
import type { SeoScanEvent } from '../../src/server/seoTypes.js'

function createRequest(
  body: Record<string, unknown>,
  payload: Record<string, unknown>,
): PayloadRequest {
  return {
    json: async () => body,
    payload,
    user: { id: 'user-1' },
  } as unknown as PayloadRequest
}

describe('SEO handlers', () => {
  beforeEach(() => {
    configureSeoState(
      [
        {
          config: {
            slug: 'pages',
            admin: { useAsTitle: 'title' },
            fields: [],
          },
          options: {
            contentFields: ['title', 'content'],
          },
        },
      ],
      {
        defaultLocale: 'en',
        locales: ['en', 'nl'],
      },
    )
  })

  it('streams a full scan using the authenticated user access rules', async () => {
    const requestPayload = {
      count: vi.fn().mockResolvedValue({ totalDocs: 1 }),
      find: vi.fn().mockResolvedValue({
        docs: [
          {
            id: 'page-1',
            content: 'Payload SEO content',
            meta: {
              description: 'A short description',
              title: 'Payload SEO',
            },
            title: 'Payload SEO page',
          },
        ],
        hasNextPage: false,
      }),
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
      },
    }
    const req = createRequest({ collections: ['pages'], locale: 'en' }, requestPayload)

    const response = await createSeoScanHandler()(req)
    const events = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as SeoScanEvent)

    expect(response.status).toBe(200)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'document-result',
        document: expect.objectContaining({
          collection: 'pages',
          id: 'page-1',
        }),
      }),
    )
    expect(requestPayload.count).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'pages',
        overrideAccess: false,
        req,
      }),
    )
    expect(requestPayload.find).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'pages',
        locale: 'en',
        overrideAccess: false,
        req,
      }),
    )
  })

  it('preserves sibling SEO fields while updating title and description', async () => {
    let document = {
      id: 'page-1',
      content: 'Payload SEO content',
      meta: {
        description: 'Old description',
        image: 'image-1',
        title: 'Old title',
      },
      title: 'Payload SEO page',
    }
    const requestPayload = {
      findByID: vi.fn(async () => document),
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
      },
      update: vi.fn(async ({ data }: { data: typeof document }) => {
        document = {
          ...document,
          ...data,
          meta: {
            ...document.meta,
            ...data.meta,
          },
        }
        return document
      }),
    }
    const req = createRequest(
      {
        id: 'page-1',
        collection: 'pages',
        description: 'New description',
        locale: 'en',
        title: 'New title',
      },
      requestPayload,
    )

    const response = await createSeoUpdateHandler()(req)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(requestPayload.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'page-1',
        data: {
          meta: {
            description: 'New description',
            image: 'image-1',
            title: 'New title',
          },
        },
        locale: 'en',
        overrideAccess: false,
        req,
      }),
    )
    expect(body.document).toMatchObject({
      description: 'New description',
      title: 'New title',
    })
  })

  it('rejects unauthenticated scans', async () => {
    const req = {
      payload: {},
      user: null,
    } as unknown as PayloadRequest

    const response = await createSeoScanHandler()(req)

    expect(response.status).toBe(401)
  })
})
