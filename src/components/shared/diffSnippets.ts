import { stripLexicalMarkers } from '../../utils/lexical.js'

function normalizePreviewText(value: string): string {
  return stripLexicalMarkers(value).replace(/\s+/g, ' ').trim()
}

function trimSnippet(value: string, start: number, end: number, radius = 42): string {
  const safeEnd = Math.max(end, start + 1)
  const left = Math.max(0, start - radius)
  const right = Math.min(value.length, safeEnd + radius)

  let snippet = value.slice(left, right).trim()
  if (!snippet) {
    snippet = value.trim()
  }

  if (left > 0) {
    snippet = `...${snippet}`
  }

  if (right < value.length) {
    snippet = `${snippet}...`
  }

  return snippet
}

/**
 * Returns a compact before/after preview around the first differing region
 * of two texts, with lexical markers stripped.
 */
export function getChangedSnippet(before: string, after: string): { after: string; before: string } {
  const normalizedBefore = normalizePreviewText(before)
  const normalizedAfter = normalizePreviewText(after)

  if (!normalizedBefore && !normalizedAfter) {
    return { after: '', before: '' }
  }

  if (normalizedBefore === normalizedAfter) {
    const fallback = trimSnippet(normalizedBefore, 0, Math.min(normalizedBefore.length, 24), 24)
    return { after: fallback, before: fallback }
  }

  let start = 0
  const maxPrefix = Math.min(normalizedBefore.length, normalizedAfter.length)
  while (start < maxPrefix && normalizedBefore[start] === normalizedAfter[start]) {
    start += 1
  }

  let beforeEnd = normalizedBefore.length - 1
  let afterEnd = normalizedAfter.length - 1

  while (
    beforeEnd >= start &&
    afterEnd >= start &&
    normalizedBefore[beforeEnd] === normalizedAfter[afterEnd]
  ) {
    beforeEnd -= 1
    afterEnd -= 1
  }

  return {
    after: trimSnippet(normalizedAfter, start, afterEnd + 1),
    before: trimSnippet(normalizedBefore, start, beforeEnd + 1),
  }
}
