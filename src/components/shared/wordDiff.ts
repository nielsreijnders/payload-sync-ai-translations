export type DiffSegment = {
  changed: boolean
  text: string
}

/**
 * Above this token count the LCS table becomes too expensive; fall back to
 * marking the whole text as changed when the values differ.
 */
const MAX_TOKENS = 400

function tokenize(value: string): string[] {
  return value.match(/\S+\s*/g) ?? []
}

function mergeSegments(segments: DiffSegment[]): DiffSegment[] {
  const merged: DiffSegment[] = []

  for (const segment of segments) {
    const last = merged.at(-1)
    if (last && last.changed === segment.changed) {
      last.text += segment.text
    } else {
      merged.push({ ...segment })
    }
  }

  return merged
}

/**
 * Word-level diff between two texts. Returns the `before` text with removed
 * words marked as changed, and the `after` text with added words marked as
 * changed, so both sides can be rendered with inline highlights.
 */
export function diffWords(
  before: string,
  after: string,
): { after: DiffSegment[]; before: DiffSegment[] } {
  if (before === after) {
    return {
      after: after ? [{ changed: false, text: after }] : [],
      before: before ? [{ changed: false, text: before }] : [],
    }
  }

  const beforeTokens = tokenize(before)
  const afterTokens = tokenize(after)

  if (beforeTokens.length > MAX_TOKENS || afterTokens.length > MAX_TOKENS) {
    return {
      after: after ? [{ changed: true, text: after }] : [],
      before: before ? [{ changed: true, text: before }] : [],
    }
  }

  // Longest-common-subsequence over normalized tokens (ignoring trailing
  // whitespace differences) so reflowed text does not read as a change.
  const normalize = (token: string) => token.trimEnd()
  const rows = beforeTokens.length + 1
  const cols = afterTokens.length + 1
  const table = new Uint32Array(rows * cols)

  for (let i = beforeTokens.length - 1; i >= 0; i -= 1) {
    for (let j = afterTokens.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        normalize(beforeTokens[i] ?? '') === normalize(afterTokens[j] ?? '')
          ? (table[(i + 1) * cols + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0)
    }
  }

  const beforeSegments: DiffSegment[] = []
  const afterSegments: DiffSegment[] = []
  let i = 0
  let j = 0

  while (i < beforeTokens.length && j < afterTokens.length) {
    if (normalize(beforeTokens[i] ?? '') === normalize(afterTokens[j] ?? '')) {
      beforeSegments.push({ changed: false, text: beforeTokens[i] ?? '' })
      afterSegments.push({ changed: false, text: afterTokens[j] ?? '' })
      i += 1
      j += 1
    } else if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0)) {
      beforeSegments.push({ changed: true, text: beforeTokens[i] ?? '' })
      i += 1
    } else {
      afterSegments.push({ changed: true, text: afterTokens[j] ?? '' })
      j += 1
    }
  }

  while (i < beforeTokens.length) {
    beforeSegments.push({ changed: true, text: beforeTokens[i] ?? '' })
    i += 1
  }

  while (j < afterTokens.length) {
    afterSegments.push({ changed: true, text: afterTokens[j] ?? '' })
    j += 1
  }

  return {
    after: mergeSegments(afterSegments),
    before: mergeSegments(beforeSegments),
  }
}
