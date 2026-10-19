import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogle } from '@ai-sdk/google'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import type { CatalogEntry, CredentialLookup } from './catalog.js'
import { registryEnvKeys, registryProvider } from './registry.js'

/**
 * Provider registry (doc《流式服务端重构》§2): adapter selection is driven by
 * the models.dev registry (models-registry.json) — entries whose npm package
 * is @ai-sdk/openai|@ai-sdk/anthropic ride those native adapters (with the
 * SDK's built-in default endpoint unless the entry overrides baseURL), every
 * other registry provider rides the official @ai-sdk/openai-compatible
 * adapter with the registry's default endpoint. API keys resolve from
 * console-entered credentials first, then the registry's env variable.
 * The lookup is sync: llm.routes prefetches a CredentialStore snapshot.
 */

export type ModelResolver = (entry: CatalogEntry) => LanguageModel

function effectiveBaseURL(entry: CatalogEntry): string | undefined {
  const fromEntry = entry.baseURL?.trim().replace(/\/+$/, '')
  if (fromEntry) return fromEntry
  const fromRegistry = registryProvider(entry.provider)?.api?.replace(/\/+$/, '')
  return fromRegistry || undefined
}

export function createModelResolver(
  credentialLookup?: CredentialLookup,
  /** Registry-aware env fallback: maps provider → its vendor key env value. */
  envKeyLookup: (provider: string) => string | undefined = (provider) => {
    for (const envKey of registryEnvKeys(provider)) {
      const value = process.env[envKey]
      if (value?.trim()) return value
    }
    return undefined
  },
): ModelResolver {
  const cache = new Map<string, (modelId: string) => LanguageModel>()
  const adapterFor = (provider: string, baseURL: string | undefined) => {
    const npm = registryProvider(provider)?.npm
    const native = npm === '@ai-sdk/openai' || npm === '@ai-sdk/anthropic' || npm === '@ai-sdk/google'
    if (!baseURL && !native) throw new Error(`provider "${provider}" has no endpoint configured`)
    const cacheKey = `${provider}::${baseURL ?? ''}`
    const cached = cache.get(cacheKey)
    if (cached !== undefined) return cached
    const apiKey = credentialLookup?.(provider, baseURL) ?? envKeyLookup(provider)
    if (!apiKey) throw new Error(`provider "${provider}" has no API key configured`)
    const options = { apiKey, ...(baseURL ? { baseURL } : {}) }
    const instance = npm === '@ai-sdk/openai'
      ? createOpenAI(options)
      : npm === '@ai-sdk/anthropic'
        ? createAnthropic(options)
        : npm === '@ai-sdk/google'
          ? createGoogle(options)
          : createOpenAICompatible({ name: provider, baseURL: baseURL!, apiKey })
    cache.set(cacheKey, instance)
    return instance
  }
  return (entry: CatalogEntry) => adapterFor(entry.provider, effectiveBaseURL(entry))(entry.model)
}
