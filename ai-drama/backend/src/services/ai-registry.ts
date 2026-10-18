/** Shared service registry for every production engine. Secrets stay server-side. */
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { providerPresets } from './production-tools/providers.js'
import { db, schema, getInsertId } from '../db/index.js'

export const serviceProviders: Record<string, readonly string[]> = {
  text: ['openai', 'gemini', 'volcengine'],
  image: ['openai', 'gemini', 'volcengine'],
  video: ['volcengine', 'minimax', 'aliyun'],
  speech: ['openai'], transcription: ['openai'],
  lipsync: ['sync'], rigging: ['meshy'], research: ['tavily'], stock: ['pexels'],
}
for (const [type, providers] of Object.entries(providerPresets)) {
  serviceProviders[type] = [...new Set([...(serviceProviders[type] || []), ...Object.keys(providers)])]
}
export type ServiceType = string
export const toolServices = {
  sync: { type: 'lipsync', baseUrl: 'https://api.sync.so', model: 'lipsync-2' },
  meshy: { type: 'rigging', baseUrl: 'https://api.meshy.ai', model: 'rigging' },
  tavily: { type: 'research', baseUrl: 'https://api.tavily.com', model: 'search' },
  pexels: { type: 'stock', baseUrl: 'https://api.pexels.com', model: 'search' },
} as const
export type ConfigRow = typeof schema.aiServiceConfigs.$inferSelect
export const rankConfigs = (a: ConfigRow, b: ConfigRow) => (b.priority ?? 0) - (a.priority ?? 0) || a.id - b.id
export function configModels(raw: string | null): string[] {
  try { const models = JSON.parse(raw || '[]'); return Array.isArray(models) ? models.filter((v): v is string => typeof v === 'string' && !!v.trim()) : [] } catch { return [] }
}

/** Transactional, repeatable upgrade: remove old secret copies only after importing. */
export function migrateServiceConfigs() {
  db.transaction(tx => {
    const now = new Date().toISOString()
    for (const [provider, spec] of Object.entries(toolServices)) {
      const key = `creative_tool_${provider}`
      const old = tx.select().from(schema.appSettings).where(eq(schema.appSettings.key, key)).get()
      if (!old) continue
      const value = JSON.parse(old.value)
      const configId = getInsertId(tx.insert(schema.aiServiceConfigs).values({
        serviceType: spec.type, provider, name: `${provider} · 已迁移`, baseUrl: spec.baseUrl,
        apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
        model: JSON.stringify([provider === 'sync' ? value.model || spec.model : spec.model]),
        isActive: !!value.enabled, priority: 0, createdAt: now, updatedAt: now,
      }).run())
      for (const job of tx.select().from(schema.creativeToolJobs).where(eq(schema.creativeToolJobs.kind, spec.type)).all()) {
        const input = JSON.parse(job.input)
        if (input.configId == null) {
          const data = { ...input, configId }
          const fingerprint = createHash('sha256').update(JSON.stringify({ kind: job.kind, data })).digest('hex')
          tx.update(schema.creativeToolJobs).set({ input: JSON.stringify(data), fingerprint }).where(eq(schema.creativeToolJobs.id, job.id)).run()
        }
      }
      tx.delete(schema.appSettings).where(eq(schema.appSettings.key, key)).run()
    }
    const marker = 'unified_service_registry_v1'
    if (tx.select().from(schema.appSettings).where(eq(schema.appSettings.key, marker)).get()) return
    // Preserve the previous OpenAI speech setup once, then manage each capability explicitly.
    const rows = tx.select().from(schema.aiServiceConfigs).all()
    const text = rows.filter(r => r.serviceType === 'text' && r.isActive && (serviceProviders.text as readonly string[]).includes(r.provider || '')).sort(rankConfigs)[0]
    if (text?.provider === 'openai' && text.apiKey) for (const [type, model] of [['speech', 'gpt-4o-mini-tts'], ['transcription', 'whisper-1']]) {
      if (rows.some(r => r.serviceType === type)) continue
      tx.insert(schema.aiServiceConfigs).values({
        serviceType: type, provider: 'openai', name: `${text.name} · ${type}`, baseUrl: text.baseUrl,
        apiKey: text.apiKey, model: JSON.stringify([model]), priority: 0, isActive: true,
        createdAt: now, updatedAt: now,
      }).run()
    }
    tx.insert(schema.appSettings).values({ key: marker, value: 'done', updatedAt: now }).run()
  })
}

export function resolveServiceRow(type: ServiceType, id?: number, includeDisabled = false) {
  migrateServiceConfigs()
  const rows = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.serviceType, type)).all()
  return rows.filter(r => (id === undefined || r.id === id) && (includeDisabled || r.isActive) &&
    (serviceProviders[type] || []).includes(r.provider || '')).sort(rankConfigs)[0]
}

/** These service adapters currently target the official API contract and origin. */
export function validateServiceConfig(type: string, provider: string, baseUrl: string, models: unknown): string | null {
  if (!Object.hasOwn(serviceProviders, type) || !(serviceProviders[type as ServiceType] as readonly string[]).includes(provider)) return '不支持的服务类型或服务商'
  if (!Array.isArray(models) || models.some(v => typeof v !== 'string' || !v.trim())) return '模型须为非空名称组成的数组'
  if (Object.hasOwn(toolServices, provider)) {
    const spec = toolServices[provider as keyof typeof toolServices]
    if (baseUrl.replace(/\/$/, '') !== spec.baseUrl) return '该专用服务目前使用官方地址，请保留预设地址'
    const allowed = provider === 'sync' ? ['lipsync-2', 'lipsync-2-pro', 'sync-3'] : [spec.model]
    if (!models.length || models.some(m => !allowed.includes(m))) return '该服务的模型或接口不受支持，请使用预设'
  }
  if (provider === 'openai' && type === 'transcription' && (models.length !== 1 || models[0] !== 'whisper-1')) return '时码识别目前支持 whisper-1'
  if (provider === 'openai' && type === 'speech' && (!models.length || models.some(m => !['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'].includes(m)))) return '请选择支持的语音合成模型'
  return null
}
