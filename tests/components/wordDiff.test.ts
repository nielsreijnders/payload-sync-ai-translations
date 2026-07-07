import { describe, expect, test } from 'vitest'

import { diffWords } from '../../src/components/shared/wordDiff.js'

function joinChanged(segments: Array<{ changed: boolean; text: string }>): string {
  return segments
    .filter((segment) => segment.changed)
    .map((segment) => segment.text.trim())
    .join(' ')
}

describe('diffWords', () => {
  test('returns unchanged segments for identical text', () => {
    const result = diffWords('Hello world', 'Hello world')

    expect(result.before).toEqual([{ changed: false, text: 'Hello world' }])
    expect(result.after).toEqual([{ changed: false, text: 'Hello world' }])
  })

  test('marks an appended sentence as added', () => {
    const before = 'Praktische tips voor vertalingen.'
    const after = 'Praktische tips voor vertalingen. En abonneer u op onze nieuwsbrief!'

    const result = diffWords(before, after)

    expect(joinChanged(result.before)).toBe('')
    expect(joinChanged(result.after)).toBe('En abonneer u op onze nieuwsbrief!')
  })

  test('marks replaced words on both sides', () => {
    const result = diffWords('The quick brown fox', 'The slow brown fox')

    expect(joinChanged(result.before)).toBe('quick')
    expect(joinChanged(result.after)).toBe('slow')
  })

  test('marks removed words in the before text', () => {
    const result = diffWords('One two three four', 'One four')

    expect(joinChanged(result.before)).toBe('two three')
    expect(joinChanged(result.after)).toBe('')
  })

  test('handles empty inputs', () => {
    expect(diffWords('', '')).toEqual({ after: [], before: [] })

    const added = diffWords('', 'New text')
    expect(added.before).toEqual([])
    expect(joinChanged(added.after)).toBe('New text')
  })

  test('merges adjacent segments of the same type', () => {
    const result = diffWords('a b c', 'x y z')

    expect(result.before).toHaveLength(1)
    expect(result.after).toHaveLength(1)
    expect(result.before[0]?.changed).toBe(true)
    expect(result.after[0]?.changed).toBe(true)
  })
})
