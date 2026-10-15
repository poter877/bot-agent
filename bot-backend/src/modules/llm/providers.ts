import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import type { LanguageModel } from 'ai'
import type { CatalogEntry } from './catalog.js'

/**
 * Vendor provider registry (doc《流式服务端重构》§2): the server picks the
 * provider from its catalog entry; vendor API keys live only in this
 * process's env and are required exactly when a catalog entry references the
 * provider (checked by resolveCatalogEntry before any vendor call).
 */

export type ProviderKey = 'openai' | 'anthropic'

export type ModelResolver = (entry: CatalogEntry) => LanguageModel

export function createModelResolver(providerApiKeys: Readonly<Record<string, string | undefined>>): ModelResolver {
  const cache = new Map<ProviderKey, ReturnType<typeof createOpenAI> | ReturnType<typeof createAnthropic>>()
  const providerFor = (key: ProviderKey) => {
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const apiKey = providerApiKeys[key]
    if (!apiKey) throw new Error(`provider "${key}" has no API key configured`)
    const instance = key === 'openai' ? createOpenAI({ apiKey }) : createAnthropic({ apiKey })
    cache.set(key, instance)
    return instance
  }
  return (entry: CatalogEntry) => providerFor(entry.provider)(entry.model)
}
