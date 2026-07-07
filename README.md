# payload-sync-ai-translations

## Overview

**payload-sync-ai-translations** is a Payload CMS plugin that adds a powerful one-click translation workflow to your projects.  
It automatically translates your documents into all available languages, intelligently detects missing context, and allows you to review and edit translations before applying them.

Built using the official [Payload Plugin Template](https://payloadcms.com/docs/plugins/overview), this plugin is reusable, modular, and easy to integrate into any Payload setup.

---

## ✨ Features

- 🔁 **One-click translation:** Instantly translate a document into all available languages.
- 🧠 **AI context detection:** Detects missing or incomplete context rather than stylistic differences.
- 💬 **Interactive review modal:** Review, skip, or edit translations before applying.
- 🚀 **Auto-sync updates:** Apply all confirmed translations across all languages.
- 📝 **Manual override:** Preserve manually edited content automatically.
- ⚙️ **Exclude specific fields:** Easily exclude fields from being translated.
- 🔎 **SEO overview:** Full-scan configured collections, score every document, and edit
  Payload SEO titles/descriptions inline.
- 🔁 **Find & replace:** Search all configured collections and globals for a text (per locale,
  optionally case-sensitive or whole-word), review the matches, and replace them in bulk.
- 🔒 **Authenticated endpoints:** All plugin endpoints require a logged-in user.

---

## 📦 Installation

Install via your package manager:

```bash
pnpm install payload-sync-ai-translations
# or
npm install payload-sync-ai-translations
```

---

## ⚙️ Usage

Add the plugin to your Payload config:

```ts
import { seoPlugin } from '@payloadcms/plugin-seo'
import { buildConfig } from 'payload/config'
import { payloadSyncAiTranslations } from 'payload-sync-ai-translations'

export default buildConfig({
  plugins: [
    seoPlugin({
      collections: ['posts'],
      uploadsCollection: 'media',
    }),
    payloadSyncAiTranslations({
      collections: {
        posts: {
          excludeFields: ['slug'],
          seo: {
            // Defaults integrate with @payloadcms/plugin-seo:
            // meta.title and meta.description
            contentFields: ['title', 'content', 'layout'],
          },
        },
      },
      openai: {
        apiKey: process.env.OPENAI_API_KEY || '',
        baseURL: process.env.OPENAI_ENDPOINT, // Optional openai compatible endpoint
      },
    }),
  ],
})
```

---

## 🔧 Plugin Options

```ts
export interface PayloadSyncAiTranslationsOptions {
  /**
   * Configure which collections to include and which fields to exclude
   */
  collections: {
    [collectionSlug: string]: {
      excludeFields?: string[]
      seo?:
        | boolean
        | {
            contentFields?: string[]
            descriptionPath?: string // default: meta.description
            labelPath?: string // default: collection admin.useAsTitle
            slugPath?: string // default: slug
            titlePath?: string // default: meta.title
          }
    }
  }

  /**
   * OpenAI configuration
   */
  openai: {
    apiKey: string
    /**
     * Optional custom endpoint URL for self-hosted or alternative OpenAI-compatible APIs.
     * Supports Azure OpenAI, local LLMs, custom proxies, and other compatible providers.
     * Example: 'https://your-domain.com/v1' or 'http://localhost:8080/v1'
     */
    baseURL?: string
    model?: string
  }

  /**
   * Optional base URL for link synchronization when your Payload `serverURL`
   * isn't set or differs from the admin URL. Relative links will be prefixed
   * with this value before fetching alternates.
   */
  serverURL?: string
}
```

The SEO overview is compatible with the official `@payloadcms/plugin-seo` fields by default. Set
`seo: true` for automatic content detection, or provide `contentFields` for a more precise score.
Custom SEO schemas can use `titlePath` and `descriptionPath`.

---

## 🧩 How It Works

When enabled, the plugin adds a **Translate** button to your Payload admin panel.

1. **Initial Translation**  
   If no translations exist, all translatable fields are automatically translated into all available languages.

2. **AI Context Check**  
   If translations already exist, the plugin uses AI to detect missing or incomplete context.

3. **Modal Review**  
   When context is missing, a modal displays suggested changes per field.  
   You can **edit**, **skip**, or **approve** fields before applying.

4. **Apply Updates**  
   Confirmed translations are synced across all language versions automatically.

### SEO overview

For collections with `seo` enabled, the plugin adds **Plugins → SEO Overview**. A full scan:

- audits every accessible document in the selected locale;
- scores metadata length, content depth, heading structure, and title/content alignment;
- sorts weak documents first and lists actionable issues;
- edits localized SEO titles and descriptions inline, then immediately recalculates the score.

### Find & replace

The plugin adds **Plugins → Find & Replace** for all configured collections and globals:

1. Enter the text to find, an optional replacement, and pick a locale.
2. Toggle **Match case** or **Whole word only** when needed.
3. **Scan for matches** — read-only, lists every field with a before/after preview.
4. Review the matches, then **Replace** to write them in one go.

Replacements run through the same safe override pipeline as the grammar check
(lexical rich text stays intact); replacements that would blank a field entirely
are skipped.

---

## 💡 Summary

By encapsulating your translation logic in a reusable Payload plugin, you can:

- Reuse translation functionality across multiple projects
- Share your work with the Payload community
- Keep your codebase clean and modular

**payload-sync-ai-translations** streamlines multilingual content management with smart, context-aware AI translations — all directly inside the Payload admin interface.

---

## License

MIT © Niels Reijnders & Codex
