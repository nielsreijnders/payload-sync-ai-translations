import { isPlainObject } from 'payload'

import { expandConcretePathsFromPattern } from '../utils/localizedFields.js'

/**
 * Shared id-pruning rules for locale-scoped saves (translation stream and
 * link sync).
 *
 * Payload matches existing array/blocks rows by `id` when merging a
 * locale-scoped update, so ids OUTSIDE localized containers must always be
 * kept: rows saved without them are recreated and every other locale's
 * values are silently dropped. Ids INSIDE localized containers describe
 * another locale's rows (locale data is built from the default locale) and
 * must be stripped so the target locale gets rows of its own.
 */

export type PruneIdentifierOptions = {
  /**
   * Normalized field patterns (`menu.[].id` style) that may keep their id
   * even inside a localized container — used for data fields that are
   * explicitly configured as translatable identifiers.
   */
  allowedPatterns?: Set<string>
  /** Concrete paths (`links.0.sublinks`) of localized array/blocks fields. */
  localizedContainers: Set<string>
}

export function collectConcreteLocalizedContainerPaths(
  data: unknown,
  patterns: string[] = [],
): Set<string> {
  const containers = new Set<string>()

  for (const pattern of patterns) {
    for (const path of expandConcretePathsFromPattern(data, pattern)) {
      containers.add(path)
    }
  }

  return containers
}

export function pruneIdentifierFields(
  value: unknown,
  options: PruneIdentifierOptions,
  currentPath = '',
  insideLocalizedContainer = false,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      const nextPath = currentPath ? `${currentPath}.${index}` : String(index)
      return pruneIdentifierFields(entry, options, nextPath, insideLocalizedContainer)
    })
  }

  if (isPlainObject(value)) {
    const record = value as Record<string, unknown>
    const next: Record<string, unknown> = {}

    for (const [key, child] of Object.entries(record)) {
      const childPath = currentPath ? `${currentPath}.${key}` : key

      if ((key === 'id' || key === '_id') && insideLocalizedContainer) {
        const normalizedChildPath = childPath.replace(/\.\d+(?=\.|$)/g, '.[]')
        if (!options.allowedPatterns?.has(normalizedChildPath)) {
          continue
        }
      }

      next[key] = pruneIdentifierFields(
        child,
        options,
        childPath,
        insideLocalizedContainer || options.localizedContainers.has(childPath),
      )
    }

    return next
  }

  return value
}
