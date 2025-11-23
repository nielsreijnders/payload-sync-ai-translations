import type { ArrayField, Field, GlobalConfig, GroupField } from 'payload'

// @ts-expect-error - validator types are incorrect
import isURL from 'validator/lib/isURL'

export type LinkProps = { label?: string; name?: string; typeDbName?: ArrayField['dbName'] }

export function LinkField(data?: LinkProps & Omit<GroupField, 'fields' | 'name' | 'type'>): Field {
  const name = data?.name || 'link'
  const typeDbName = data?.typeDbName

  const restObject = {
    name,
    ...data,
  }

  return {
    type: 'group',
    interfaceName: 'LinkGroup',
    ...restObject,
    fields: [
      {
        name: 'label',
        type: 'text',
        localized: true,
        // required: true,
      },
      {
        name: 'linkType',
        label: 'Link type',
        ...(typeDbName ? { dbName: typeDbName } : {}),
        localized: true,
        // required: true,
        type: 'radio',
        admin: {
          description: 'Choose between linking to another route or entering a custom text URL',
        },
        defaultValue: 'internal',
        options: [
          {
            label: 'Internal Link',
            value: 'internal',
          },
          {
            label: 'Custom URL',
            value: 'custom',
          },
        ],
      },
      {
        name: 'internal',
        type: 'relationship',
        admin: {
          condition: (_, siblingData) => siblingData.linkType === 'internal',
        },
        hooks: {
          beforeValidate: [
            ({ siblingData, value }) => {
              if (siblingData.linkType !== 'internal') {
                return null
              }

              return value
            },
          ],
        },
        label: 'Choose a route to link to',
        localized: true,
        relationTo: ['posts'],
        // required: true,
      },
      {
        name: 'custom',
        type: 'text',
        admin: {
          condition: (_, siblingData) => siblingData.linkType === 'custom',
        },
        label: 'Enter a URL',
        // hooks: {
        //   beforeValidate: [
        //     ({ value, siblingData }) => {
        //       if (siblingData.linkType !== "custom") {
        //         return "";
        //       }

        //       if (value === "#") {
        //         return value;
        //       }

        //       if (value) {
        //         try {
        //           let url = new URL(value, "https://example.com");
        //           if (!value.startsWith("http://") && !value.startsWith("https://")) {
        //             url = new URL(`https://${value}`);
        //           }
        //           return url.toString().replace(/\/$/, "");
        //           // eslint-disable-next-line @typescript-eslint/no-unused-vars
        //         } catch (error) {
        //           // Throw a more descriptive error
        //           throw new Error(`Invalid URL: ${value}. Please include a valid protocol and domain.`);
        //         }
        //       }

        //       return value;
        //     },
        //   ],
        // },
        localized: true,
        validate: (value?: null | string) => {
          if (!value) {
            return 'Required'
          }

          if (
            !isURL(value, {
              require_host: false,
              require_port: false,
              require_protocol: false,
              require_valid_protocol: false,
            })
          ) {
            return 'Invalid URL'
          }

          return true
        },
        // required: true,
      },
      {
        name: 'target',
        type: 'checkbox',
        defaultValue: false,
        label: 'Open in new tab',
        localized: true,
      },
    ],
  }
}

type ButtonProps = {
  maxRows?: number
  minRows?: number
  name?: string
}

export function LinksField(data?: ButtonProps): Field {
  const name = data?.name || 'links'
  const minRows = data?.minRows || undefined
  const maxRows = data?.maxRows || undefined

  return {
    name,
    type: 'array',
    fields: [LinkField()],
    localized: true,
    maxRows,
    minRows,
  }
}

export const menuGlobal: GlobalConfig = {
  slug: 'menu',
  fields: [
    { ...LinkField({ name: 'USP' }) },
    {
      name: 'mainMenu',
      type: 'array',
      fields: [
        {
          ...LinkField({ name: 'link' }),
        },
        {
          name: 'sublinks',
          type: 'array',
          fields: [
            {
              name: 'chapeau',
              type: 'text',
              localized: true,
            },
            {
              ...LinksField({ name: 'links' }),
            },
          ],
          localized: true,
        },
      ],
      localized: true,
    },
    {
      ...LinksField({ name: 'secondaryMenu' }),
    },
  ],
  hooks: {
    // afterChange: [revLayoutOnDemand],
  },
}
