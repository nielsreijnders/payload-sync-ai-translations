function cloneLocaleData<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value)
  }

  return JSON.parse(JSON.stringify(value)) as T
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const STRUCTURE_SKIP_KEYS = new Set(['createdAt', 'updatedAt'])

function getIdentity(value: unknown): null | number | string {
  if (!isPlainObject(value)) {
    return null
  }

  const record = value as { _id?: unknown; id?: unknown }
  const identifier = record._id ?? record.id

  if (typeof identifier === 'string' || typeof identifier === 'number') {
    return identifier
  }

  return null
}

function cloneStructuralShape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneStructuralShape(entry))
  }

  if (isPlainObject(value)) {
    const record = value
    const out: Record<string, unknown> = {}

    if (typeof record.blockType === 'string') {
      out.blockType = record.blockType
    }

    for (const [key, child] of Object.entries(record)) {
      if (STRUCTURE_SKIP_KEYS.has(key)) {
        continue
      }

      if (Array.isArray(child) || isPlainObject(child)) {
        out[key] = cloneStructuralShape(child)
        continue
      }

      out[key] = child
    }

    return out
  }

  return undefined
}

export function mergeStructuralData(base: unknown, target: unknown): unknown {
  if (Array.isArray(base)) {
    const baseArray = base as unknown[]
    const targetArray = Array.isArray(target) ? [...target] : []
    const used = new Set<number>()
    const result: unknown[] = new Array(baseArray.length)

    baseArray.forEach((item, index) => {
      const identity = getIdentity(item)
      let matchIndex = -1

      if (identity !== null) {
        for (let i = 0; i < targetArray.length; i += 1) {
          if (used.has(i)) {
            continue
          }

          if (getIdentity(targetArray[i]) === identity) {
            matchIndex = i
            break
          }
        }
      }

      if (
        matchIndex === -1 &&
        index < targetArray.length &&
        !used.has(index)
      ) {
        matchIndex = index
      }

      if (matchIndex !== -1) {
        used.add(matchIndex)
        result[index] = mergeStructuralData(item, targetArray[matchIndex])
        return
      }

      const cloned = cloneStructuralShape(item)
      result[index] = cloned !== undefined ? cloned : item
    })

    targetArray.forEach((entry, index) => {
      if (!used.has(index)) {
        result.push(entry)
      }
    })

    return result
  }

  if (isPlainObject(base)) {
    const baseRecord = base
    const targetRecord = isPlainObject(target) ? { ...target } : {}

    if (typeof baseRecord.blockType === 'string' && typeof targetRecord.blockType !== 'string') {
      targetRecord.blockType = baseRecord.blockType
    }

    for (const [key, value] of Object.entries(baseRecord)) {
      if (STRUCTURE_SKIP_KEYS.has(key)) {
        if (!(key in targetRecord)) {
          targetRecord[key] = value
        }
        continue
      }

      if (Array.isArray(value) || isPlainObject(value)) {
        targetRecord[key] = mergeStructuralData(value, targetRecord[key])
        continue
      }

      if (!(key in targetRecord)) {
        targetRecord[key] = value
      }
    }

    return targetRecord
  }

  return target ?? base
}

export function setValueAtPath(
  original: unknown,
  source: unknown,
  path: string,
  value: unknown,
): unknown {
  const segments = path.split('.')

  const apply = (origBranch: unknown, current: unknown, index: number): unknown => {
    if (index >= segments.length) {
      return value
    }

    const segment = segments[index]
    const isIndex = /^\d+$/.test(segment)

    if (isIndex) {
      const position = Number(segment)
      const origArray = Array.isArray(origBranch) ? origBranch : undefined
      const targetArray = Array.isArray(current) ? [...current] : []
      const nextOrig = origArray && origArray.length > position ? origArray[position] : undefined
      const existing = targetArray[position]
      const applied = apply(nextOrig, existing, index + 1)

      if (
        applied &&
        typeof applied === 'object' &&
        !Array.isArray(applied) &&
        nextOrig &&
        typeof nextOrig === 'object' &&
        (nextOrig as { blockType?: unknown }).blockType &&
        !(applied as { blockType?: unknown }).blockType
      ) {
        ;(applied as Record<string, unknown>).blockType = (
          nextOrig as {
            blockType?: unknown
          }
        ).blockType as string
      }

      targetArray[position] = applied
      return targetArray
    }

    const origRecord =
      typeof origBranch === 'object' && origBranch !== null && !Array.isArray(origBranch)
        ? (origBranch as Record<string, unknown>)
        : undefined
    const targetRecord =
      typeof current === 'object' && current !== null && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>) }
        : {}
    const nextOrig = origRecord ? origRecord[segment] : undefined
    targetRecord[segment] = apply(nextOrig, targetRecord[segment], index + 1)
    return targetRecord
  }

  return apply(original, source, 0)
}

export { cloneLocaleData }
