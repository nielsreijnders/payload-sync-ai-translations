import { parse } from 'node-html-parser'

import type { StoredSeoCollection } from './seoState.js'
import type { SeoScanDocument, SeoScoreStatus } from './seoTypes.js'

import { isLexicalValue } from '../utils/lexical.js'
import { extractPlainText, getValueAtPath } from '../utils/localizedFields.js'

const SYSTEM_KEYS = new Set([
  '__v',
  '_id',
  '_status',
  'blockname',
  'blocktype',
  'createdat',
  'deletedat',
  'email',
  'filename',
  'filesize',
  'focalsy',
  'focalx',
  'height',
  'id',
  'mimetype',
  'password',
  'relationto',
  'salt',
  'sizes',
  'thumbnailurl',
  'updatedat',
  'url',
  'value',
  'width',
])

const STOP_WORDS = new Set([
  'aan',
  'and',
  'are',
  'bij',
  'dan',
  'dat',
  'de',
  'der',
  'des',
  'die',
  'een',
  'en',
  'for',
  'from',
  'het',
  'met',
  'naar',
  'of',
  'on',
  'the',
  'this',
  'to',
  'van',
  'voor',
  'with',
])

type ContentMetrics = {
  headingCount: number
  text: string
  wordCount: number
}

function normalizeText(value: string): string {
  const normalized = /<\/?[a-z][\s\S]*>/i.test(value) ? parse(value).textContent : value
  return normalized.replace(/\s+/g, ' ').trim()
}

function collectLexicalHeadings(value: unknown): number {
  if (!isLexicalValue(value)) {
    return 0
  }

  let count = 0
  const visit = (node: unknown) => {
    if (typeof node !== 'object' || node === null) {
      return
    }

    const record = node as { children?: unknown[]; type?: unknown }
    if (record.type === 'heading') {
      count += 1
    }
    record.children?.forEach(visit)
  }

  visit(value.root)
  return count
}

function collectTextValues(
  value: unknown,
  path: string,
  parts: string[],
  metrics: { headingCount: number },
): void {
  if (typeof value === 'string') {
    if (/<\/?[a-z][\s\S]*>/i.test(value)) {
      metrics.headingCount += parse(value).querySelectorAll('h1, h2, h3, h4, h5, h6').length
    } else if (/(?:^|\.)(?:heading|headline|title)$/i.test(path)) {
      metrics.headingCount += 1
    }
    const normalized = normalizeText(value)
    if (normalized) {
      parts.push(normalized)
    }
    return
  }

  if (isLexicalValue(value)) {
    const text = extractPlainText(value)
    if (text) {
      parts.push(text)
    }
    metrics.headingCount += collectLexicalHeadings(value)
    return
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectTextValues(entry, `${path}.${index}`, parts, metrics))
    return
  }

  if (typeof value !== 'object' || value === null) {
    return
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SYSTEM_KEYS.has(key.toLowerCase())) {
      continue
    }
    collectTextValues(child, path ? `${path}.${key}` : key, parts, metrics)
  }
}

function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0
}

function getContentMetrics(doc: unknown, config: StoredSeoCollection): ContentMetrics {
  const parts: string[] = []
  const metrics = { headingCount: 0 }

  if (config.contentFields?.length) {
    for (const path of config.contentFields) {
      collectTextValues(getValueAtPath(doc, path), path, parts, metrics)
    }
  } else if (typeof doc === 'object' && doc !== null) {
    const excludedRoots = new Set([
      config.descriptionPath.split('.')[0],
      config.slugPath.split('.')[0],
      config.titlePath.split('.')[0],
    ])

    for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
      if (excludedRoots.has(key) || SYSTEM_KEYS.has(key.toLowerCase())) {
        continue
      }
      collectTextValues(value, key, parts, metrics)
    }
  }

  const text = parts.join(' ').replace(/\s+/g, ' ').trim()
  return {
    headingCount: metrics.headingCount,
    text,
    wordCount: countWords(text),
  }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function titleTerms(title: string): string[] {
  return Array.from(
    new Set(
      title
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}]+/gu)
        ?.filter((term) => term.length >= 3 && !STOP_WORDS.has(term)) ?? [],
    ),
  )
}

function getStatus(score: number): SeoScoreStatus {
  if (score >= 80) {
    return 'good'
  }
  if (score >= 50) {
    return 'needs-work'
  }
  return 'poor'
}

function scoreLength(
  value: string,
  range: { max: number; min: number },
  points: { ideal: number; partial: number },
): number {
  if (value.length >= range.min && value.length <= range.max) {
    return points.ideal
  }

  const lowerBound = Math.max(1, Math.round(range.min * 0.6))
  const upperBound = Math.round(range.max * 1.2)
  if (value.length >= lowerBound && value.length <= upperBound) {
    return points.partial
  }

  return Math.round(points.partial / 2)
}

export function scoreSeoDocument(
  doc: Record<string, unknown>,
  config: StoredSeoCollection,
  locale: string,
): SeoScanDocument {
  const title = asText(getValueAtPath(doc, config.titlePath))
  const description = asText(getValueAtPath(doc, config.descriptionPath))
  const metrics = getContentMetrics(doc, config)
  const issues: string[] = []
  let score = 0

  if (title) {
    score += 15
    score += scoreLength(title, { max: 60, min: 50 }, { ideal: 15, partial: 8 })
    if (title.length < 50 || title.length > 60) {
      issues.push(`SEO title is ${title.length} characters; aim for 50–60.`)
    }
  } else {
    issues.push('SEO title is missing.')
  }

  if (description) {
    score += 15
    score += scoreLength(description, { max: 150, min: 100 }, { ideal: 15, partial: 8 })
    if (description.length < 100 || description.length > 150) {
      issues.push(`SEO description is ${description.length} characters; aim for 100–150.`)
    }
  } else {
    issues.push('SEO description is missing.')
  }

  if (metrics.wordCount >= 300) {
    score += 20
  } else if (metrics.wordCount >= 150) {
    score += 14
    issues.push(`Content has ${metrics.wordCount} words; 300+ gives search engines more context.`)
  } else if (metrics.wordCount >= 50) {
    score += 8
    issues.push(`Content is thin at ${metrics.wordCount} words.`)
  } else if (metrics.wordCount > 0) {
    score += 4
    issues.push(`Content is very thin at ${metrics.wordCount} words.`)
  } else {
    issues.push('No indexable content was found.')
  }

  if (metrics.headingCount > 0) {
    score += 10
  } else {
    issues.push('No heading was found in the configured content.')
  }

  const terms = titleTerms(title)
  if (terms.length) {
    const content = metrics.text.toLocaleLowerCase()
    const matches = terms.filter((term) => content.includes(term)).length
    const ratio = matches / terms.length

    if (ratio >= 0.6) {
      score += 10
    } else if (ratio >= 0.3) {
      score += 6
      issues.push('Only part of the SEO title terminology appears in the content.')
    } else if (matches > 0) {
      score += 3
      issues.push('The SEO title has little overlap with the page content.')
    } else {
      issues.push('The SEO title terminology does not appear in the page content.')
    }
  } else {
    issues.push('Add a descriptive SEO title to evaluate content alignment.')
  }

  const boundedScore = Math.max(0, Math.min(100, score))
  const identifier = doc.id ?? doc._id
  const id =
    typeof identifier === 'string' || typeof identifier === 'number' ? identifier : 'unknown'
  const label =
    asText(getValueAtPath(doc, config.labelPath)) ||
    title ||
    `${config.label.replace(/s$/i, '')} ${String(id)}`
  const slug = asText(getValueAtPath(doc, config.slugPath)) || undefined
  const updatedAt = asText(doc.updatedAt) || undefined

  return {
    id,
    slug,
    collection: config.slug,
    description,
    headingCount: metrics.headingCount,
    issues,
    label,
    locale,
    score: boundedScore,
    status: getStatus(boundedScore),
    title,
    updatedAt,
    wordCount: metrics.wordCount,
  }
}
