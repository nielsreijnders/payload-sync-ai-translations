import OpenAI from 'openai'

import { getOpenAISettings } from './settings.js'

const DEFAULT_MODEL = 'gpt-4o-mini'

const SYSTEM_PROMPT = [
  'You are a translation engine.',
  'Reply using strict JSON that matches {"t": ["..."]}.',
  'Preserve order, punctuation, inline formatting, casing, and any HTML tags or placeholders exactly as provided.',
  'Do not translate product names, slugs, codes, or URLs.',
].join(' ')

const REVIEW_SYSTEM_PROMPT = [
  'You are a translation quality assistant.',
  'Reply using strict JSON that matches {"issues":[{"index":0,"missing":false,"reason":""}]}.',
  'Do not include any additional text outside of the JSON.',
].join(' ')

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

function getClientAndModel(): { client: OpenAI; model: string } {
  const settings = getOpenAISettings()
  if (!settings?.apiKey) {
    throw new Error('Missing OpenAI API key')
  }

  const client = new OpenAI({ apiKey: settings.apiKey })
  const model = settings.model || DEFAULT_MODEL

  return { client, model }
}

export async function openAiTranslateTexts(
  inputs: string[],
  from: string,
  to: string,
): Promise<string[]> {
  if (!inputs.length) {
    return []
  }

  const { client, model } = getClientAndModel()
  const numbered = inputs.map((value, index) => `${index + 1}. ${value}`).join('\n')
  const userPrompt = [
    `Translate each line from ${from} to ${to}.`,
    'Keep formatting, punctuation, and all HTML tags or placeholders unchanged.',
    `Return strict JSON in the shape {"t": [...]} with exactly ${inputs.length} entries.`,
    numbered,
  ].join('\n')

  const response = await client.chat.completions.create({
    messages: [
      { content: SYSTEM_PROMPT, role: 'system' },
      { content: userPrompt, role: 'user' },
    ],
    model,
    temperature: 0,
  })

  const content = response?.choices?.[0]?.message?.content ?? '{}'

  let parsed: unknown = {}
  try {
    parsed = JSON.parse(content)
  } catch {
    const fallbackMatch = content.match(/\{[\s\S]*\}$/)
    parsed = fallbackMatch ? JSON.parse(fallbackMatch[0]) : {}
  }

  const list = Array.isArray((parsed as { t?: unknown[] })?.t) ? (parsed as { t: unknown[] }).t : []
  if (list.length !== inputs.length) {
    return inputs
  }

  return list.map(coerceString)
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
    temperature: 0,
  })

  const content = response?.choices?.[0]?.message?.content ?? '{}'

  let parsed: unknown = {}
  try {
    parsed = JSON.parse(content)
  } catch {
    const fallbackMatch = content.match(/\{[\s\S]*\}$/)
    parsed = fallbackMatch ? JSON.parse(fallbackMatch[0]) : {}
  }

  const issues = Array.isArray((parsed as { issues?: unknown }).issues)
    ? ((parsed as { issues: unknown[] }).issues as Array<{ index?: unknown; missing?: unknown; reason?: unknown }>)
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
