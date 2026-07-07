import { describe, expect, test } from 'vitest'

import {
  buildSyncSnapshot,
  buildTargetKey,
  computeLocaleStatuses,
  countSnapshotChanges,
  hashSnapshotText,
} from '../../src/server/syncStatusStore.js'

describe('buildTargetKey', () => {
  test('builds collection and global keys', () => {
    expect(buildTargetKey({ collection: 'posts', documentId: 12 })).toBe('posts:12')
    expect(buildTargetKey({ collection: 'posts', documentId: 'abc' })).toBe('posts:abc')
    expect(buildTargetKey({ global: 'header' })).toBe('global:header')
  })
})

describe('buildSyncSnapshot', () => {
  test('hashes item text deterministically', () => {
    const items = [
      { lexical: false, path: 'title', text: 'Hello world' },
      { lexical: true, path: 'content', text: '[[LEX-0]]Body[[/LEX-0]]' },
    ]

    const snapshot = buildSyncSnapshot(items)

    expect(snapshot).toEqual([
      { hash: hashSnapshotText('Hello world'), lexical: false, path: 'title' },
      { hash: hashSnapshotText('[[LEX-0]]Body[[/LEX-0]]'), lexical: true, path: 'content' },
    ])
    expect(buildSyncSnapshot(items)).toEqual(snapshot)
  })
})

describe('countSnapshotChanges', () => {
  const base = buildSyncSnapshot([
    { lexical: false, path: 'title', text: 'Hello' },
    { lexical: false, path: 'intro', text: 'Welcome' },
  ])

  test('returns zero for identical content', () => {
    expect(countSnapshotChanges(base, base)).toBe(0)
  })

  test('counts edited fields', () => {
    const current = buildSyncSnapshot([
      { lexical: false, path: 'title', text: 'Hello there' },
      { lexical: false, path: 'intro', text: 'Welcome' },
    ])

    expect(countSnapshotChanges(current, base)).toBe(1)
  })

  test('counts added and removed fields', () => {
    const current = buildSyncSnapshot([
      { lexical: false, path: 'title', text: 'Hello' },
      { lexical: false, path: 'outro', text: 'Bye' },
    ])

    // intro removed + outro added
    expect(countSnapshotChanges(current, base)).toBe(2)
  })

  test('treats lexical flag as part of the identity', () => {
    const current = buildSyncSnapshot([
      { lexical: true, path: 'title', text: 'Hello' },
      { lexical: false, path: 'intro', text: 'Welcome' },
    ])

    // title switched from plain to lexical: old entry removed + new entry added
    expect(countSnapshotChanges(current, base)).toBe(2)
  })
})

describe('computeLocaleStatuses', () => {
  const current = buildSyncSnapshot([{ lexical: false, path: 'title', text: 'Hello' }])

  test('reports never-synced locales with all fields as changed', () => {
    const [status] = computeLocaleStatuses(current, [], ['nl'])

    expect(status).toEqual({ changedFields: 1, locale: 'nl', status: 'never-synced' })
  })

  test('reports synced when the snapshot matches', () => {
    const [status] = computeLocaleStatuses(
      current,
      [{ locale: 'nl', snapshot: current, syncedAt: '2026-07-01T00:00:00.000Z' }],
      ['nl'],
    )

    expect(status).toEqual({
      changedFields: 0,
      locale: 'nl',
      status: 'synced',
      syncedAt: '2026-07-01T00:00:00.000Z',
    })
  })

  test('reports out-of-sync when content changed after the last sync', () => {
    const stored = buildSyncSnapshot([{ lexical: false, path: 'title', text: 'Old title' }])
    const [status] = computeLocaleStatuses(
      current,
      [{ locale: 'nl', snapshot: stored, syncedAt: '2026-07-01T00:00:00.000Z' }],
      ['nl'],
    )

    expect(status.status).toBe('out-of-sync')
    expect(status.changedFields).toBe(1)
  })

  test('treats documents without translatable content as synced', () => {
    const [status] = computeLocaleStatuses([], [], ['nl'])

    expect(status).toEqual({ changedFields: 0, locale: 'nl', status: 'synced' })
  })
})
