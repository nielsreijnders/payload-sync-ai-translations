'use client'

/**
 * The plugin's tool globals (bulk translation, grammar check, link sync, SEO
 * overview) never persist data through the global document form, so the
 * default "Save" button would only confuse. This replaces it with nothing.
 */
export function HiddenSaveButton(): null {
  return null
}
