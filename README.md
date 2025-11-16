# payload-sync-ai-translations

## Overview

**payload-sync-ai-translations** is a Payload CMS plugin that adds a powerful one-click translation workflow to your projects.  
It automatically translates your documents into all available languages, intelligently detects missing context, and allows you to review and edit translations before applying them.

Built using the official [Payload Plugin Template](https://payloadcms.com/docs/plugins/overview), this plugin is reusable, modular, and easy to integrate into any Payload setup.

---

## ✨ Features

- 🔁 **One-click translation:** Instantly translate a document into all available languages.
- ⚙️ **Exclude specific fields:** Easily exclude fields from being translated.
- 🧠 **AI context detection:** Detects missing or incomplete context rather than stylistic differences.
- 💬 **Interactive review modal:** Review, skip, or edit translations before applying.
- 🚀 **Auto-sync updates:** Apply all confirmed translations across all languages.
- 📝 **Manual override:** Preserve manually edited content automatically.

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
import { buildConfig } from 'payload/config'
import { payloadSyncAiTranslations } from 'payload-sync-ai-translations'

export default buildConfig({
  plugins: [
    payloadSyncAiTranslations({
      collections: {
        posts: {
          excludeFields: ['slug'],
        },
      },
      openai: {
        apiKey: process.env.OPENAI_API_KEY || '',
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
    }
  }

  /**
   * OpenAI configuration
   */
  openai: {
    apiKey: string
  }
}
```

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

---

## 🧱 Development

To contribute or build your own plugin, use the official Payload Plugin Template as a base.

### Start from the Template

```bash
npx create-payload-app@latest --template plugin
```

### Folder Structure

```
/ (root)
├── package.json        # Plugin metadata and dependencies
├── README.md           # Documentation
├── /src                # Plugin source code
└── /dev                # Local Payload environment for testing
```

Then open [http://localhost:3000](http://localhost:3000).

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
