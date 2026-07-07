/**
 * Minimal RFC 4180 CSV helpers — no dependencies. Handles quoted fields,
 * escaped quotes, and newlines inside quoted values.
 */

function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }

  return value
}

export function serializeCsv(rows: string[][]): string {
  return rows.map((row) => row.map(escapeCsvField).join(',')).join('\r\n')
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let index = 0

  // Strip a UTF-8 BOM so the first header cell parses cleanly.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  const pushField = () => {
    row.push(field)
    field = ''
  }

  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }

  while (index < input.length) {
    const char = input[index] as string

    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }

        inQuotes = false
        index += 1
        continue
      }

      field += char
      index += 1
      continue
    }

    if (char === '"') {
      inQuotes = true
      index += 1
      continue
    }

    if (char === ',') {
      pushField()
      index += 1
      continue
    }

    if (char === '\r') {
      if (input[index + 1] === '\n') {
        index += 1
      }
      pushRow()
      index += 1
      continue
    }

    if (char === '\n') {
      pushRow()
      index += 1
      continue
    }

    field += char
    index += 1
  }

  // Flush the last field/row when the input does not end with a newline.
  if (field.length || row.length) {
    pushRow()
  }

  // Drop rows that are entirely empty (e.g. a trailing blank line).
  return rows.filter((entry) => entry.some((value) => value.trim().length))
}

/**
 * Triggers a browser download of `content` as a UTF-8 CSV file. The BOM makes
 * Excel detect the encoding correctly.
 */
export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([`﻿${content}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
