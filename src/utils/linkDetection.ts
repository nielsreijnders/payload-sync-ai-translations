const ABSOLUTE_PATTERN = /^(https?:)?\/\//i

export function looksLikeLink(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return false
  }

  if (ABSOLUTE_PATTERN.test(trimmed)) {
    return true
  }

  if (trimmed.startsWith('/')) {
    return true
  }

  if (trimmed.includes('/') || trimmed.includes('?') || trimmed.includes('#')) {
    return true
  }

  return false
}
