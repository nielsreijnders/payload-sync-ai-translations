import type { AiLocalizationCollectionOptions } from '../plugin.js'

export type CollectionRuntimeConfig = {
  label: string
  options: AiLocalizationCollectionOptions
}

let collectionConfig: Record<string, CollectionRuntimeConfig> = {}

export function setCollectionOptionsMap(map: Record<string, CollectionRuntimeConfig>) {
  collectionConfig = { ...map }
}

export function getCollectionRuntimeConfig(
  slug: string,
): CollectionRuntimeConfig | undefined {
  return collectionConfig[slug]
}

export function getAllCollectionRuntimeConfigs(): Record<string, CollectionRuntimeConfig> {
  return { ...collectionConfig }
}
