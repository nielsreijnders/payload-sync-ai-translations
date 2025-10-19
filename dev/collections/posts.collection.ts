import type { CollectionConfig } from 'payload'

export const posts: CollectionConfig = {
  slug: 'posts',
  admin: {
    useAsTitle: 'title',
  },
  fields: [
    {
      name: 'title',
      type: 'text',
      localized: true,
      required: true,
    },
    {
      name: 'slug',
      type: 'text',
      admin: {
        position: 'sidebar',
      },
      localized: true,
      required: true,
      unique: true,
    },
    {
      name: 'content',
      type: 'richText',
      localized: true,
      required: true,
    },
    {
      name: 'components',
      type: 'blocks',
      blocks: [
        {
          slug: 'textBlock',
          fields: [
            {
              name: 'text',
              type: 'text',
              localized: true,
            },
            {
              name: 'button',
              type: 'group',
              fields: [
                {
                  name: 'label',
                  type: 'text',
                  localized: true,
                },
                {
                  name: 'url',
                  type: 'text',
                  localized: true,
                },
              ],
            },
          ],
        },
        {
          slug: 'teamBlock',
          fields: [
            {
              name: 'members',
              type: 'relationship',
              hasMany: true,
              relationTo: ['users', 'media'],
            },
          ],
        },
      ],
    },
  ],
}
