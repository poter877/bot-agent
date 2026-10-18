import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '../../db/index.js'
import { resolveServiceRow, toolServices, configModels } from '../ai-registry.js'
import { CreativeError } from '../creative-model.js'
export const providerSchema = z.enum(['sync', 'meshy', 'tavily', 'pexels'])
export type ToolProvider = z.infer<typeof providerSchema>
const configSchema = z.object({
  enabled: z.boolean(),
  apiKey: z.string().max(4096),
  model: z.enum(['lipsync-2', 'lipsync-2-pro', 'sync-3']).default('lipsync-2'),
})
export function toolConfig(provider: ToolProvider, configId?: number) {
  const row = resolveServiceRow(toolServices[provider].type, configId) ??
    resolveServiceRow(toolServices[provider].type, configId, true)
  return { id: row?.id, enabled: !!row?.isActive, apiKey: row?.apiKey || '',
    model: configModels(row?.model ?? null)[0] || toolServices[provider].model }
}
export function publicToolSettings() {
  return providerSchema.options.map(provider => {
    const { apiKey, ...config } = toolConfig(provider)
    return { provider, ...config, configured: !!apiKey }
  })
}
/** Compatibility API; the shared registry is the only source of credentials. */
export function saveToolSettings(provider: ToolProvider, body: unknown) {
  const patch = z.object({ enabled: z.boolean(), apiKey: z.string().trim().max(4096).optional(),
    clearKey: z.boolean().optional(), model: configSchema.shape.model.optional() }).strict().parse(body)
  const old = toolConfig(provider), spec = toolServices[provider]
  const apiKey = patch.clearKey ? '' : patch.apiKey || old.apiKey
  if (patch.enabled && !apiKey) throw new CreativeError('请先填写该服务的 API Key')
  const next = { isActive: patch.enabled, apiKey,
    model: JSON.stringify([provider === 'sync' ? patch.model || old.model : spec.model]), updatedAt: new Date().toISOString() }
  if (old.id) db.update(schema.aiServiceConfigs).set(next).where(eq(schema.aiServiceConfigs.id, old.id)).run()
  else db.insert(schema.aiServiceConfigs).values({ ...next, serviceType: spec.type, provider,
    name: provider, baseUrl: spec.baseUrl, createdAt: next.updatedAt }).run()
  return publicToolSettings()
}
export function requireToolConfig(provider: ToolProvider, configId?: number) {
  const config = toolConfig(provider, configId)
  if (!config.enabled || !config.apiKey)
    throw new CreativeError(`请在设置的「模型与服务」中配置并启用 ${provider}${configId ? `（配置 #${configId}）` : ''}`, 503)
  return config
}
