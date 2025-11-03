import type { Payload } from 'payload'

import { devUser } from './helpers/credentials.js'

const createLexicalParagraph = (text: string) => ({
  root: {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          {
            type: 'text',
            detail: 0,
            format: 0,
            mode: 'normal',
            style: '',
            text,
            version: 1,
          },
        ],
        direction: 'ltr',
        format: '',
        indent: 0,
        version: 1,
      },
    ],
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
  },
})

const createTextBlock = ({
  buttonLabel,
  buttonUrl,
  subText,
  text,
}: {
  buttonLabel: string
  buttonUrl: string
  subText: string
  text: string
}) => ({
  blockType: 'textBlock',
  button: { label: buttonLabel, url: buttonUrl },
  group: { subText: createLexicalParagraph(subText) },
  text,
})

const seededPosts = [
  {
    slug: 'exploring-localization-workflows',
    components: [
      createTextBlock({
        buttonLabel: 'Read localization guide',
        buttonUrl: '/posts/exploring-localization-workflows',
        subText:
          'This post walks through configuring locales, syncing translations, and previewing results.',
        text: 'Discover localization best practices in Payload CMS.',
      }),
    ],
    content: createLexicalParagraph(
      'An overview of how Payload can streamline authoring content across multiple locales.',
    ),
    title: 'Exploring Localization Workflows',
  },
  {
    slug: 'ai-translation-tips',
    components: [
      createTextBlock({
        buttonLabel: 'Explore AI tips',
        buttonUrl: '/posts/ai-translation-tips',
        subText:
          'From prompt crafting to review checklists, learn how to deliver consistent multilingual content.',
        text: 'Level-up your AI assisted translation workflow.',
      }),
    ],
    content: createLexicalParagraph(
      'Practical advice for reviewing and polishing AI assisted translations within your workflow.',
    ),
    title: 'AI Translation Tips',
  },
  {
    slug: 'managing-rich-text-components',
    components: [
      createTextBlock({
        buttonLabel: 'Review component patterns',
        buttonUrl: '/posts/managing-rich-text-components',
        subText:
          'Break down complex layouts into manageable blocks with clear translation guidance.',
        text: 'Structure rich text components for translators.',
      }),
    ],
    content: createLexicalParagraph(
      'Learn strategies for organizing localized content inside complex block-based layouts.',
    ),
    title: 'Managing Rich Text Components',
  },
]

let hasRun = false

export const seed = async (payload: Payload) => {
  if (hasRun || (globalThis as any).__seeded) {
    return
  }
  hasRun = true
  ;(globalThis as any).__seeded = true

  const { totalDocs: userCount } = await payload.count({
    collection: 'users',
    where: { email: { equals: devUser.email } },
  })

  if (!userCount) {
    await payload.create({ collection: 'users', data: devUser })
  }

  const { totalDocs: postCount } = await payload.count({ collection: 'posts' })

  if (!postCount) {
    await Promise.all(
      seededPosts.map((post) =>
        payload.create({
          collection: 'posts',
          data: post,
        }),
      ),
    )
  }
}
