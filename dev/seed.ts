import type { Payload } from 'payload'

import { devUser } from './helpers/credentials.js'

const createLexicalParagraph = (text: string) => ({
  root: {
    children: [
      {
        children: [
          {
            detail: 0,
            format: 0,
            mode: 'normal',
            style: '',
            text,
            type: 'text',
            version: 1,
          },
        ],
        direction: 'ltr',
        format: '',
        indent: 0,
        type: 'paragraph',
        version: 1,
      },
    ],
    direction: 'ltr',
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  },
})

const createTextBlock = ({
  text,
  buttonLabel,
  buttonUrl,
  subText,
}: {
  text: string
  buttonLabel: string
  buttonUrl: string
  subText: string
}) => ({
  blockType: 'textBlock',
  text: { en: text },
  button: {
    label: { en: buttonLabel },
    url: { en: buttonUrl },
  },
  group: {
    subText: {
      en: createLexicalParagraph(subText),
    },
  },
})

const seededPosts = [
  {
    title: { en: 'Exploring Localization Workflows' },
    slug: { en: 'exploring-localization-workflows' },
    content: {
      en: createLexicalParagraph(
        'An overview of how Payload can streamline authoring content across multiple locales.',
      ),
    },
    components: [
      createTextBlock({
        text: 'Discover localization best practices in Payload CMS.',
        buttonLabel: 'Read localization guide',
        buttonUrl: '/posts/exploring-localization-workflows',
        subText: 'This post walks through configuring locales, syncing translations, and previewing results.',
      }),
    ],
  },
  {
    title: { en: 'AI Translation Tips' },
    slug: { en: 'ai-translation-tips' },
    content: {
      en: createLexicalParagraph(
        'Practical advice for reviewing and polishing AI assisted translations within your workflow.',
      ),
    },
    components: [
      createTextBlock({
        text: 'Level-up your AI assisted translation workflow.',
        buttonLabel: 'Explore AI tips',
        buttonUrl: '/posts/ai-translation-tips',
        subText: 'From prompt crafting to review checklists, learn how to deliver consistent multilingual content.',
      }),
    ],
  },
  {
    title: { en: 'Managing Rich Text Components' },
    slug: { en: 'managing-rich-text-components' },
    content: {
      en: createLexicalParagraph(
        'Learn strategies for organizing localized content inside complex block-based layouts.',
      ),
    },
    components: [
      createTextBlock({
        text: 'Structure rich text components for translators.',
        buttonLabel: 'Review component patterns',
        buttonUrl: '/posts/managing-rich-text-components',
        subText: 'Break down complex layouts into manageable blocks with clear translation guidance.',
      }),
    ],
  },
]

export const seed = async (payload: Payload) => {
  const { totalDocs } = await payload.count({
    collection: 'users',
    where: {
      email: {
        equals: devUser.email,
      },
    },
  })

  if (!totalDocs) {
    await payload.create({
      collection: 'users',
      data: devUser,
    })
  }

  const { totalDocs: existingPosts } = await payload.count({
    collection: 'posts',
  })

  if (!existingPosts) {
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
