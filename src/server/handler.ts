import type { PayloadHandler } from 'payload'

import type {
  TranslateLocaleRequestPayload,
  TranslateRequestPayload,
  TranslateStreamEvent,
} from './types.js'

import { streamTranslations } from './stream.js'

const encoder = new TextEncoder()

function isTranslateItem(
  value: unknown,
): value is TranslateLocaleRequestPayload['chunks'][number][number] {
  return (
    typeof (value as { path?: unknown }).path === 'string' &&
    typeof (value as { text?: unknown }).text === 'string' &&
    typeof (value as { lexical?: unknown }).lexical === 'boolean'
  )
}

function isTranslateChunk(value: unknown): value is TranslateLocaleRequestPayload['chunks'][number] {
  return Array.isArray(value) && value.every(isTranslateItem)
}

function parseBody(body: unknown): TranslateRequestPayload {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Invalid JSON body')
  }

  const candidate = body as Record<string, unknown>
  const from = candidate.from
  const collection = candidate.collection
  const identifier = candidate.id
  const locales = candidate.locales

  if (typeof from !== 'string' || from.length === 0) {
    throw new Error('Missing "from" locale')
  }

  if (typeof collection !== 'string' || collection.length === 0) {
    throw new Error('Missing "collection" slug')
  }

  if (typeof identifier !== 'string' && typeof identifier !== 'number') {
    throw new Error('Missing document "id"')
  }

  if (typeof identifier === 'string' && identifier.length === 0) {
    throw new Error('Missing document "id"')
  }

  if (!Array.isArray(locales) || !locales.length) {
    throw new Error('No target locales provided')
  }

  const parsedLocales: TranslateLocaleRequestPayload[] = []

  for (const entry of locales) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('Invalid locale entry')
    }

    const code = (entry as { code?: unknown }).code
    const chunks = (entry as { chunks?: unknown }).chunks
    const overrides = (entry as { overrides?: unknown }).overrides

    if (typeof code !== 'string' || !code) {
      throw new Error('Elke taal moet een niet-lege locale code bevatten')
    }

    if (!Array.isArray(chunks) || !chunks.every(isTranslateChunk)) {
      throw new Error('Elke taal moet geldige vertaalitems bevatten')
    }

    if (
      overrides !== undefined &&
      (!Array.isArray(overrides) || !overrides.every(isTranslateItem))
    ) {
      throw new Error('Elke taal moet geldige overrides bevatten')
    }

    parsedLocales.push({
      chunks,
      code,
      overrides: Array.isArray(overrides) && overrides.length ? overrides : undefined,
    })
  }

  if (!parsedLocales.length) {
    throw new Error('No translation data provided')
  }

  return { id: identifier, collection, from, locales: parsedLocales }
}

function serializeEvent(event: TranslateStreamEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`)
}

export function createAiTranslateHandler(): PayloadHandler {
  return async (req) => {
    try {
      const payload = req.payload
      if (!payload) {
        throw new Error('Payload instance is not available on the request')
      }

      const parsed = parseBody(await req.json())

      const stream = new ReadableStream({
        async start(controller) {
          try {
            for await (const event of streamTranslations(payload, parsed)) {
              controller.enqueue(serializeEvent(event))
              if (event.type === 'error' || event.type === 'done') {
                break
              }
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to sync translations'
            controller.enqueue(serializeEvent({ type: 'error', message }))
          } finally {
            controller.close()
          }
        },
      })

      return new Response(stream, {
        headers: {
          'Cache-Control': 'no-cache, no-transform',
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request body'
      return Response.json({ type: 'error', message }, { status: 400 })
    }
  }
}
