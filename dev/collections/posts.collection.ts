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
    // Tabs example
    {
      type: 'tabs',
      tabs: [
        {
          name: 'settings',
          fields: [
            {
              name: 'isFeatured',
              type: 'checkbox',
            },
          ],
          label: 'Settings',
        },
      ],
    },
    {
      name: 'components',
      type: 'blocks',
      blocks: [
        // Voeg een test block toe met tabs
        {
          slug: 'tabbedBlock',
          fields: [
            {
              type: 'tabs',
              tabs: [
                {
                  name: 'tab1',
                  fields: [
                    {
                      name: 'fieldInTab1',
                      type: 'text',
                      localized: true,
                    },
                  ],
                  label: 'Tab 1',
                },
                {
                  name: 'tab2',
                  fields: [
                    {
                      name: 'fieldInTab2',
                      type: 'richText',
                      localized: true,
                    },
                  ],
                  label: 'Tab 2',
                },
              ],
            },
          ],
        },
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
            {
              name: 'group',
              type: 'group',
              fields: [
                {
                  name: 'subText',
                  type: 'richText',
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
