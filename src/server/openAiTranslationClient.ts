import OpenAI from 'openai'

import { extractLexicalPlaceholderIndexes } from '../utils/lexical.js'
import { logDebug } from './debugSettings.js'
import { getOpenAISettings } from './openAiSettings.js'

const DEFAULT_MODEL = 'gpt-4o-mini'

const SYSTEM_PROMPT = [
  'You are a translation engine.',
  'Reply using strict JSON that matches {"t": ["..."]}.',
  'Preserve order, punctuation, inline formatting, and casing.',
  'Do not translate product names, slugs, codes, or URLs.',
  'Only translate the user-provided "items" array and nothing else.',
].join(' ')

const REVIEW_SYSTEM_PROMPT = [
  'You are a translation quality assistant.',
  'Reply using strict JSON that matches {"issues":[{"index":0,"missing":false,"reason":""}]}.',
  'Do not include any additional text outside of the JSON.',
].join(' ')

const PROOFREAD_SYSTEM_PROMPT = [
  'You are a proofreading assistant.',
  'Reply using strict JSON that matches {"t":["..."]}.',
  'Correct clear typos, spelling mistakes, and grammar errors only.',
  'Keep the same language and do not translate.',
  'Preserve placeholders, casing, punctuation, and formatting.',
].join(' ')

const LEXICAL_MARKER_ERROR =
  'Invalid translation response from OpenAI: lexical markers were modified or removed.'

const URL_PROTOCOL_PATTERN = /^[a-z]+:\/\//i
const SPECIAL_SCHEME_PATTERN = /^(?:mailto|tel|sms):/i
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/
const PATH_SAFE_PATTERN = /^\/[\w\-.~:/?#@!$&'()*+,;=%]*$/
const SLUG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/i
const UPPER_CODE_PATTERN = /^[A-Z0-9_-]{3,}$/
const NUMBER_PATTERN = /^\d+(?:[.,]\d+)?$/

function containsLexicalMarkers(value: string): boolean {
  return value.includes('[[LEX-')
}

function lexicalMarkersMatch(source: string, translated: string): boolean {
  const sourceMarkers = extractLexicalPlaceholderIndexes(source)
  if (!sourceMarkers.length) {
    return true
  }

  const translatedMarkers = extractLexicalPlaceholderIndexes(translated)
  if (sourceMarkers.length !== translatedMarkers.length) {
    return false
  }

  return sourceMarkers.every((marker, index) => marker === translatedMarkers[index])
}

export function shouldPreserveOriginalValue(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || containsLexicalMarkers(trimmed)) {
    return false
  }

  if (URL_PROTOCOL_PATTERN.test(trimmed) || SPECIAL_SCHEME_PATTERN.test(trimmed)) {
    return true
  }

  if (trimmed.startsWith('/')) {
    return PATH_SAFE_PATTERN.test(trimmed)
  }

  if (EMAIL_PATTERN.test(trimmed)) {
    return true
  }

  const noSpaces = !/\s/.test(trimmed)
  if (!noSpaces) {
    return false
  }

  if (NUMBER_PATTERN.test(trimmed)) {
    return true
  }

  if (SLUG_PATTERN.test(trimmed)) {
    return true
  }

  if (UPPER_CODE_PATTERN.test(trimmed)) {
    return true
  }

  if (/\d/.test(trimmed) && /[A-Z]/i.test(trimmed)) {
    return true
  }

  if (trimmed.includes('.') && /^[\w.-]+$/.test(trimmed)) {
    return true
  }

  return false
}

function coerceString(value: unknown): string {
  if (value == null) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function normalizeTranslationEntries(entries: unknown[], expectedLength: number): null | string[] {
  if (expectedLength <= 0 || entries.length !== expectedLength) {
    return null
  }

  return entries.map((entry) => coerceString(entry))
}

function safeParseJsonResponse(content: string): unknown {
  const trimmed = content.trim()

  const tryParse = (value: null | string | undefined): unknown => {
    if (!value) {
      return null
    }

    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }

  const attemptRepair = (value: string): null | string => {
    const trailingWhitespaceMatch = value.match(/\s*$/)
    const trailingWhitespace = trailingWhitespaceMatch ? trailingWhitespaceMatch[0] : ''
    let base = value.slice(0, value.length - trailingWhitespace.length)

    const countUnclosed = (source: string, open: string, close: string): number => {
      let depth = 0
      let inString = false
      let escaping = false

      for (const char of source) {
        if (escaping) {
          escaping = false
          continue
        }

        if (char === '\\') {
          escaping = true
          continue
        }

        if (char === '"') {
          inString = !inString
          continue
        }

        if (inString) {
          continue
        }

        if (char === open) {
          depth += 1
        } else if (char === close) {
          if (depth > 0) {
            depth -= 1
          }
        }
      }

      return depth
    }

    const unclosedSquare = countUnclosed(base, '[', ']')
    const unclosedBrace = countUnclosed(base, '{', '}')

    let modified = false

    if (unclosedSquare > 0) {
      const trimmedBase = base.trimEnd()
      if (trimmedBase.endsWith('}')) {
        base = `${trimmedBase.slice(0, -1)}${']'.repeat(unclosedSquare)}}`
      } else {
        base = `${trimmedBase}${']'.repeat(unclosedSquare)}`
      }
      modified = true
    }

    if (unclosedBrace > 0) {
      base = `${base}${'}'.repeat(unclosedBrace)}`
      modified = true
    }

    if (!modified) {
      return null
    }

    return `${base}${trailingWhitespace}`
  }

  const directParse = tryParse(trimmed)
  if (directParse) {
    return directParse
  }

  const fallbackMatch = trimmed.match(/\{[\s\S]*\}$/)
  const fallbackParse = tryParse(fallbackMatch?.[0])
  if (fallbackParse) {
    return fallbackParse
  }

  const repaired = attemptRepair(fallbackMatch?.[0] ?? trimmed)
  if (repaired) {
    const repairedParse = tryParse(repaired)
    if (repairedParse) {
      return repairedParse
    }
  }

  return null
}

function getClientAndModel(): { client: OpenAI; model: string } {
  const settings = getOpenAISettings()
  if (!settings?.apiKey) {
    throw new Error('Missing OpenAI API key')
  }

  const client = new OpenAI({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL
  })

  const model = settings.model || DEFAULT_MODEL

  return { client, model }
}

export async function openAiTranslateTexts(
  inputs: string[],
  from: string,
  to: string,
  options: { customPrompt?: string } = {},
): Promise<string[]> {
  if (!inputs.length) {
    return []
  }

  const { client, model } = getClientAndModel()
  const itemsPayload = JSON.stringify(inputs)

  const userPromptSections = [
    `Translate the values inside the "items" array from locale "${from}" to locale "${to}".`,
    'Keep formatting and punctuation.',
    'If text includes markers like [[LEX-0]]...[[/LEX-0]], preserve them exactly as-is.',
    `Return strict JSON in the shape {"t": [...]} with exactly ${inputs.length} entries in the same order as "items".`,
    'Do not include translations for anything outside of the "items" array.',
    'Do not add numbering or bullet markers that are not present in the source text.',
  ]

  if (options.customPrompt) {
    userPromptSections.push(`Custom instructions: ${options.customPrompt}`)
  }

  // Prevent the ai model from translating the prompt itself by isolating the items payload
  userPromptSections.push(`items: ${itemsPayload}`)

  const userPrompt = userPromptSections.join('\n')

  const response = await client.chat.completions.create({
    messages: [
      { content: SYSTEM_PROMPT, role: 'system' },
      { content: userPrompt, role: 'user' },
    ],
    model,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'ai_translation_response',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            t: {
              type: 'array',
              items: { type: 'string' },
              maxItems: inputs.length,
              minItems: inputs.length,
            },
          },
          required: ['t'],
        },
      },
    },
    temperature: 0,
  })

  logDebug(null, '[AI Translate] OpenAI chat completion executed.', {
    model,
    requestMessages: [
      { content: SYSTEM_PROMPT, role: 'system' },
      { content: userPrompt, role: 'user' },
    ],
    responseMetadata: {
      id: response.id,
      created: response.created,
      usage: response.usage,
    },
  })

  const content = response?.choices?.[0]?.message?.content ?? '{}'

  logDebug(null, '[AI Translate] OpenAI raw response content.', {
    content,
    customPromptApplied: Boolean(options.customPrompt),
  })

  const parsed: unknown = safeParseJsonResponse(content)

  if (!parsed || typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid translation response from OpenAI: unable to parse JSON payload.')
  }

  const list = Array.isArray((parsed as { t?: unknown[] })?.t)
    ? (parsed as { t: unknown[] }).t
    : null

  if (!Array.isArray(list)) {
    throw new Error('Invalid translation response from OpenAI: missing "t" array.')
  }

  const normalized = normalizeTranslationEntries(list, inputs.length)

  if (!normalized || normalized.length !== inputs.length) {
    throw new Error(
      `Invalid translation response from OpenAI: expected ${inputs.length} entries, received ${list.length}.`,
    )
  }

  return normalized.map((entry, index) => {
    const source = inputs[index] ?? ''
    const coerced = entry

    if (containsLexicalMarkers(source) && !lexicalMarkersMatch(source, coerced)) {
      throw new Error(LEXICAL_MARKER_ERROR)
    }

    if (shouldPreserveOriginalValue(source)) {
      return source
    }

    return coerced
  })
}

export async function openAiProofreadTexts(
  inputs: string[],
  locale: string,
  options: { customPrompt?: string } = {},
): Promise<string[]> {
  if (!inputs.length) {
    return []
  }

  const { client, model } = getClientAndModel()
  const itemsPayload = JSON.stringify(inputs)

  const userPromptSections = [
    `Proofread the values inside the "items" array for locale "${locale}".`,
    'Fix obvious typos, spelling mistakes, and grammar errors.',
    'Do not translate to another language.',
    'Keep style and tone unchanged unless required for a correction.',
    'If text includes markers like [[LEX-0]]...[[/LEX-0]], preserve them exactly as-is.',
    `Return strict JSON in the shape {"t": [...]} with exactly ${inputs.length} entries in the same order as "items".`,
    'If an item is already correct, return it unchanged.',
  ]

  if (options.customPrompt) {
    userPromptSections.push(`Additional instructions: ${options.customPrompt}`)
  }

  userPromptSections.push(`items: ${itemsPayload}`)

  const userPrompt = userPromptSections.join('\n')

  const response = await client.chat.completions.create({
    messages: [
      { content: PROOFREAD_SYSTEM_PROMPT, role: 'system' },
      { content: userPrompt, role: 'user' },
    ],
    model,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'ai_proofread_response',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            t: {
              type: 'array',
              items: { type: 'string' },
              maxItems: inputs.length,
              minItems: inputs.length,
            },
          },
          required: ['t'],
        },
      },
    },
    temperature: 0,
  })

  logDebug(null, '[AI Grammar] OpenAI proofread completion executed.', {
    model,
    requestMessages: [
      { content: PROOFREAD_SYSTEM_PROMPT, role: 'system' },
      { content: userPrompt, role: 'user' },
    ],
    responseMetadata: {
      id: response.id,
      created: response.created,
      usage: response.usage,
    },
  })

  const content = response?.choices?.[0]?.message?.content ?? '{}'

  logDebug(null, '[AI Grammar] OpenAI proofread raw response content.', {
    content,
    customPromptApplied: Boolean(options.customPrompt),
  })

  const parsed: unknown = safeParseJsonResponse(content)

  if (!parsed || typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid proofread response from OpenAI: unable to parse JSON payload.')
  }

  const list = Array.isArray((parsed as { t?: unknown[] })?.t)
    ? (parsed as { t: unknown[] }).t
    : null

  if (!Array.isArray(list)) {
    throw new Error('Invalid proofread response from OpenAI: missing "t" array.')
  }

  const normalized = normalizeTranslationEntries(list, inputs.length)

  if (!normalized || normalized.length !== inputs.length) {
    throw new Error(
      `Invalid proofread response from OpenAI: expected ${inputs.length} entries, received ${list.length}.`,
    )
  }

  return normalized.map((entry, index) => {
    const source = inputs[index] ?? ''
    const coerced = entry

    if (containsLexicalMarkers(source) && !lexicalMarkersMatch(source, coerced)) {
      throw new Error(LEXICAL_MARKER_ERROR)
    }

    if (shouldPreserveOriginalValue(source)) {
      return source
    }

    return coerced
  })
}

export type MissingInformationCheckInput = {
  defaultText: string
  index: number
  translatedText: string
}

export type MissingInformationCheckResult = {
  index: number
  missing: boolean
  reason: string
}

export async function openAiDetectMissingInformation(
  inputs: MissingInformationCheckInput[],
  from: string,
  to: string,
): Promise<MissingInformationCheckResult[]> {
  if (!inputs.length) {
    return []
  }

  const { client, model } = getClientAndModel()
  const payload = JSON.stringify(
    inputs.map((item) => ({
      defaultText: item.defaultText,
      index: item.index,
      translatedText: item.translatedText,
    })),
  )

  const userPrompt = [
    `Base locale: ${from}. Target locale: ${to}.`,
    'Analyse the JSON array. For each entry, decide if translatedText lacks important information present in defaultText.',
    'Respond with JSON {"issues":[{"index":number,"missing":boolean,"reason":string}]} including one entry per input item.',
    'Reason must be empty when missing is false and limited to 20 words otherwise.',
    `Input: ${payload}`,
  ].join('\n')

  const response = await client.chat.completions.create({
    messages: [
      { content: REVIEW_SYSTEM_PROMPT, role: 'system' },
      { content: userPrompt, role: 'user' },
    ],
    model,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'ai_translation_review_response',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            issues: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  index: { type: 'integer' },
                  missing: { type: 'boolean' },
                  reason: { type: 'string' },
                },
                required: ['index', 'missing', 'reason'],
              },
            },
          },
          required: ['issues'],
        },
      },
    },
    temperature: 0,
  })

  logDebug(null, '[AI Translate] OpenAI review completion executed.', {
    model,
    requestMessages: [
      { content: REVIEW_SYSTEM_PROMPT, role: 'system' },
      { content: userPrompt, role: 'user' },
    ],
    responseMetadata: {
      id: response.id,
      created: response.created,
      usage: response.usage,
    },
  })

  const content = response?.choices?.[0]?.message?.content ?? '{}'

  logDebug(null, '[AI Translate] OpenAI review raw response content.', { content })

  let parsed: unknown = {}
  try {
    parsed = JSON.parse(content)
  } catch {
    const fallbackMatch = content.match(/\{[\s\S]*\}$/)
    parsed = fallbackMatch ? JSON.parse(fallbackMatch[0]) : {}
  }

  const issues = Array.isArray((parsed as { issues?: unknown }).issues)
    ? ((parsed as { issues: unknown[] }).issues as Array<{
        index?: unknown
        missing?: unknown
        reason?: unknown
      }>)
    : []

  return inputs.map((item) => {
    const match = issues.find((issue) => (issue.index as number | undefined) === item.index)
    if (!match) {
      return { index: item.index, missing: false, reason: '' }
    }

    const missing = Boolean(match.missing)
    const reason = typeof match.reason === 'string' ? match.reason.trim() : ''

    return {
      index: item.index,
      missing,
      reason: missing ? reason : '',
    }
  })
}
