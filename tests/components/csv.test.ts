import { describe, expect, test } from 'vitest'

import { parseCsv, serializeCsv } from '../../src/components/shared/csv.js'

describe('serializeCsv', () => {
  test('joins plain fields with commas and CRLF', () => {
    expect(
      serializeCsv([
        ['a', 'b'],
        ['c', 'd'],
      ]),
    ).toBe('a,b\r\nc,d')
  })

  test('quotes fields containing commas, quotes, and newlines', () => {
    expect(serializeCsv([['hello, world', 'say "hi"', 'line1\nline2']])).toBe(
      '"hello, world","say ""hi""","line1\nline2"',
    )
  })
})

describe('parseCsv', () => {
  test('parses plain rows', () => {
    expect(parseCsv('a,b\r\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  test('parses quoted fields with commas, escaped quotes, and newlines', () => {
    expect(parseCsv('"hello, world","say ""hi""","line1\nline2"')).toEqual([
      ['hello, world', 'say "hi"', 'line1\nline2'],
    ])
  })

  test('strips a UTF-8 BOM and trailing blank lines', () => {
    expect(parseCsv('﻿a,b\nc,d\n\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  test('round-trips serialized content', () => {
    const rows = [
      ['collection', 'id', 'seo_title', 'seo_description'],
      ['posts', '42', 'Tips & "tricks", deel 1', 'Eerste regel\nTweede regel'],
    ]

    expect(parseCsv(serializeCsv(rows))).toEqual(rows)
  })

  test('keeps empty fields inside a row', () => {
    expect(parseCsv('a,,c')).toEqual([['a', '', 'c']])
  })
})
