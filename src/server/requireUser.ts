import type { PayloadRequest } from 'payload'

/**
 * All plugin endpoints trigger OpenAI usage and/or content writes, so they
 * must never be callable anonymously. Returns a 401 response when the
 * request carries no authenticated user, or null when the request may
 * proceed.
 */
export function rejectUnauthenticated(req: PayloadRequest): null | Response {
  if (!req.user) {
    return Response.json(
      { type: 'error', message: 'You must be logged in to use this endpoint.' },
      { status: 401 },
    )
  }

  return null
}
