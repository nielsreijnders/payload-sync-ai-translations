import { describe, expect, it } from 'vitest'

import { splitLexicalText } from '../../src/utils/lexical.js'

describe('splitLexicalText', () => {
  it('returns the original text when within the limit', () => {
    const text = '[[LEX-0]]Hello[[/LEX-0]]\n\n[[LEX-1]]World[[/LEX-1]]'
    const result = splitLexicalText(text, 100)

    expect(result).toEqual([text])
  })

  it('splits long lexical content on placeholder boundaries', () => {
    const text = [
      '[[LEX-0]]First paragraph content[[/LEX-0]]',
      '[[LEX-1]]Second paragraph content[[/LEX-1]]',
      '[[LEX-2]]Third paragraph content[[/LEX-2]]',
    ].join('\n\n')

    const result = splitLexicalText(text, 60)

    expect(result.length).toBeGreaterThan(1)
    expect(result.join('')).toBe(text)
    expect(result[0]).toContain('[[LEX-0]]')
    expect(result[result.length - 1]).toContain('[[LEX-2]]')
  })
})
