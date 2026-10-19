/** Shared service registry for every production engine. Secrets stay server-side. */
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { providerPresets } from './production-tools/providers.js'
import { companyBackendUrl, companyBaseUrl, companyConfigured, companyServiceToken } from './company-backend.js'
import { db, schema, getInsertId } from '../db/index.js'

/**
 * 基础白名单：文本/图像/视频/语音/转写一律走公司后端（provider='company'），
 * 厂商直连已下线。专用工具（fal/sync 等逻辑名）是工具行，只换连接数据，
 * 由 serviceProviders() 与工具预设的并集保留。
 */
const baseServiceProviders: Record<string, readonly string[]> = {
  text: ['company'],
  image: ['company'],
  video: ['company'],
  speech: ['company'], transcription: ['company'],
  lipsync: ['sync'], rigging: ['meshy'], research: ['tavily'], stock: ['pexels'],
}
let providersIndex: Record<string, readonly string[]> | null = null
/** 白名单合并了工具预设（其 fal 地址来自 env）；providers 链先于 dotenv 求值，只能惰性合并。 */
export function serviceProviders(): Record<string, readonly string[]> {
  if (!providersIndex) {
    providersIndex = { ...baseServiceProviders }
    for (const [type, presets] of Object.entries(providerPresets())) {
      providersIndex[type] = [...new Set([...(providersIndex[type] || []), ...Object.keys(presets)])]
    }
  }
  return providersIndex
}
export type ServiceType = string
export const toolServices = {
  sync: { type: 'lipsync', baseUrl: 'https://api.sync.so', model: 'lipsync-2' },
  meshy: { type: 'rigging', baseUrl: 'https://api.meshy.ai', model: 'rigging' },
  tavily: { type: 'research', baseUrl: 'https://api.tavily.com', model: 'search' },
  pexels: { type: 'stock', baseUrl: 'https://api.pexels.com', model: 'search' },
} as const
/** 已下线的厂商直连 provider（历史行由迁移归一为 company）。 */
const legacyDirectVendors = ['openai', 'gemini', 'volcengine', 'minimax', 'aliyun']
/** 统一走公司后端的服务类型。 */
const companyTypes = ['text', 'image', 'video', 'speech', 'transcription']
export type ConfigRow = typeof schema.aiServiceConfigs.$inferSelect
export const rankConfigs = (a: ConfigRow, b: ConfigRow) => (b.priority ?? 0) - (a.priority ?? 0) || a.id - b.id
export function configModels(raw: string | null): string[] {
  try { const models = JSON.parse(raw || '[]'); return Array.isArray(models) ? models.filter((v): v is string => typeof v === 'string' && !!v.trim()) : [] } catch { return [] }
}

/**
 * Transactional, repeatable upgrade. v1 imported legacy tool secrets; v2
 * switches the core capabilities to the company backend and retargets the fal
 * tool rows once env credentials exist (marker bump re-runs the idempotent
 * block on deployments that already migrated).
 */
export async function migrateServiceConfigs() {
  await (await db.transaction(async tx => {
    const now = new Date().toISOString()
    for (const [provider, spec] of Object.entries(toolServices)) {
      const key = `creative_tool_${provider}`
      const old = (await tx.select().from(schema.appSettings).where(eq(schema.appSettings.key, key)))[0]
      if (!old) continue
      const value = JSON.parse(old.value)
      const configId = (await tx.insert(schema.aiServiceConfigs).values({
        serviceType: spec.type, provider, name: `${provider} · 已迁移`, baseUrl: spec.baseUrl,
        apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
        model: JSON.stringify([provider === 'sync' ? value.model || spec.model : spec.model]),
        isActive: !!value.enabled, priority: 0, createdAt: now, updatedAt: now,
      }).returning({ id: schema.aiServiceConfigs.id }))[0]!.id
      for (const job of (await tx.select().from(schema.creativeToolJobs).where(eq(schema.creativeToolJobs.kind, spec.type)))) {
        const input = JSON.parse(job.input)
        if (input.configId == null) {
          const data = { ...input, configId }
          const fingerprint = createHash('sha256').update(JSON.stringify({ kind: job.kind, data })).digest('hex');
          (await tx.update(schema.creativeToolJobs).set({ input: JSON.stringify(data), fingerprint }).where(eq(schema.creativeToolJobs.id, job.id)))
        }
      };
      (await tx.delete(schema.appSettings).where(eq(schema.appSettings.key, key)))
    }
    // 公司后端收敛（v2：fal 队列在公司后端内化，v1 的 fal-queue 透传代理已
    // 删除）：历史厂商直连配置只改活跃行（历史行保留），模型置空待选；fal
    // 工具行只换连接数据——地址与 company 行同源、密钥换成内部服务令牌。
    // 整段幂等，标记更名让已迁移部署再跑一遍，把 fal 行迁到新地址。
    const marker = 'company_backend_registry_v2'
    if (!companyConfigured() || (await tx.select().from(schema.appSettings).where(eq(schema.appSettings.key, marker)))[0]) return;
    (await tx.delete(schema.appSettings).where(eq(schema.appSettings.key, 'company_backend_registry_v1')))
    const rows = (await tx.select().from(schema.aiServiceConfigs))
    for (const type of companyTypes) {
      const active = rows.filter(r => r.serviceType === type && r.isActive)
      const target = { provider: 'company', baseUrl: companyBaseUrl(type), apiKey: companyServiceToken(), model: '[]' }
      const legacy = active.filter(r => legacyDirectVendors.includes(r.provider || ''))
      for (const row of legacy) {
        await tx.update(schema.aiServiceConfigs).set({ ...target, updatedAt: now }).where(eq(schema.aiServiceConfigs.id, row.id))
      }
      if (!active.length) {
        await tx.insert(schema.aiServiceConfigs).values({
          serviceType: type, name: `公司后端 · ${type}`,
          ...target, priority: 0, isActive: true, createdAt: now, updatedAt: now,
        }).returning()
      }
    }
    for (const row of rows.filter(r => r.isActive && r.provider === 'fal')) {
      await tx.update(schema.aiServiceConfigs).set({
        baseUrl: companyBackendUrl(), apiKey: companyServiceToken(), updatedAt: now,
      }).where(eq(schema.aiServiceConfigs.id, row.id))
    };
    (await tx.insert(schema.appSettings).values({ key: marker, value: companyBackendUrl(), updatedAt: now }))
  }))
}

export async function resolveServiceRow(type: ServiceType, id?: number, includeDisabled = false) {
  migrateServiceConfigs()
  const rows = (await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.serviceType, type)))
  return rows.filter(r => (id === undefined || r.id === id) && (includeDisabled || r.isActive) &&
    (serviceProviders()[type] || []).includes(r.provider || '')).sort(rankConfigs)[0]
}

/** These service adapters currently target the official API contract and origin.
 *  company 行不再校验 model：模型 id 的真相源是公司目录（company-model-catalog），
 *  配置行 model 只是历史展示/手工收藏，运行时不读它。 */
export function validateServiceConfig(type: string, provider: string, baseUrl: string, models: unknown): string | null {
  if (!Object.hasOwn(serviceProviders(), type) || !(serviceProviders()[type as ServiceType] as readonly string[]).includes(provider)) return '不支持的服务类型或服务商'
  const isCompanyRow = provider === 'company'
  const modelList = Array.isArray(models) ? (models as unknown[]) : []
  if (!isCompanyRow && (!Array.isArray(models) || modelList.some(v => typeof v !== 'string' || !v.trim()))) return '模型须为非空名称组成的数组'
  if (Object.hasOwn(toolServices, provider)) {
    const spec = toolServices[provider as keyof typeof toolServices]
    if (baseUrl.replace(/\/$/, '') !== spec.baseUrl) return '该专用服务目前使用官方地址，请保留预设地址'
    const allowed = provider === 'sync' ? ['lipsync-2', 'lipsync-2-pro', 'sync-3'] : [spec.model]
    if (!modelList.length || modelList.some(m => typeof m !== 'string' || !allowed.includes(m))) return '该服务的模型或接口不受支持，请使用预设'
  }
  if (isCompanyRow) {
    if (!companyConfigured()) return '未配置公司后端（COMPANY_BACKEND_URL / COMPANY_SERVICE_TOKEN）'
    if (baseUrl.replace(/\/+$/, '') !== companyBaseUrl(type)) return '公司服务地址由服务端环境注入，请保留预设地址'
  }
  return null
}
