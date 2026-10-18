/**
 * 公司模型目录（bot-backend）— 模型 id 的唯一真相源。
 *
 * text → GET {COMPANY}/api/llm/models（publicModelCatalog：{models:[{id,displayName,…}], defaultModel}）
 * image/video/speech/transcription → GET {COMPANY}/api/media/models
 *   （publicMediaCatalog：{models:[{id,kind,displayName,maxImages?}]}，按 kind 过滤，无 default 字段）。
 * 配置行（ai_service_configs.model）不再承载模型真相；运行时默认模型在这里解析：
 * 目录 defaultModel（text）或该 kind 的首项（媒体），结果短 TTL 缓存避免每任务一跳。
 */
import { companyBackendUrl, companyServiceToken } from './company-backend.js'
import { logTaskWarn } from '../utils/task-logger.js'

export type CompanyModelKind = 'text' | 'image' | 'video' | 'speech' | 'transcription'
export const companyModelKinds: readonly CompanyModelKind[] = ['text', 'image', 'video', 'speech', 'transcription']

export interface CompanyModelEntry {
  id: string
  displayName: string
}

export interface CompanyModelCatalog {
  models: CompanyModelEntry[]
  /** text 用目录 defaultModel；媒体目录无默认标记，取该 kind 首项 */
  defaultModel: string | null
}

export function isCompanyModelKind(value: string): value is CompanyModelKind {
  return (companyModelKinds as readonly string[]).includes(value)
}

function normalizeEntries(payload: unknown): CompanyModelEntry[] {
  const list = Array.isArray((payload as any)?.models)
    ? (payload as any).models
    : Array.isArray((payload as any)?.data)
      ? (payload as any).data
      : []
  return list
    .map((item: any) => ({
      id: typeof item?.id === 'string' ? item.id : '',
      displayName: typeof item?.displayName === 'string' && item.displayName ? item.displayName : String(item?.id ?? ''),
    }))
    .filter((entry: CompanyModelEntry) => entry.id)
}

/** 目录不含敏感凭据；30s 与 bot-backend 的 no-store 响应头对齐请求节奏即可。 */
async function fetchCatalogJson(kind: CompanyModelKind): Promise<unknown> {
  const url = kind === 'text' ? `${companyBackendUrl()}/api/llm/models` : `${companyBackendUrl()}/api/media/models`
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${companyServiceToken()}` },
    signal: AbortSignal.timeout(30000),
  })
  if (!resp.ok) throw new Error(`公司模型目录请求失败（${resp.status}）`)
  return resp.json()
}

/** 单跳拉取并归一：不缓存，供路由代理与测试使用。 */
export async function fetchCompanyModelCatalog(kind: CompanyModelKind): Promise<CompanyModelCatalog> {
  const payload = await fetchCatalogJson(kind)
  if (kind === 'text') {
    const models = normalizeEntries(payload)
    const declared = typeof (payload as any)?.defaultModel === 'string' ? (payload as any).defaultModel : ''
    return { models, defaultModel: models.some((m) => m.id === declared) ? declared : (models[0]?.id ?? null) }
  }
  const ofKind = normalizeEntries(
    Array.isArray((payload as any)?.models)
      ? { models: (payload as any).models.filter((item: any) => item?.kind === kind) }
      : payload,
  )
  return { models: ofKind, defaultModel: ofKind[0]?.id ?? null }
}

const CATALOG_TTL_MS = 60_000
const cache = new Map<CompanyModelKind, { expiresAt: number; data: CompanyModelCatalog }>()

/** 测试隔离用：清空运行时目录缓存。 */
export function resetCompanyModelCatalogCache() {
  cache.clear()
}

/** TTL 缓存版：运行时默认模型解析走这里，避免每个任务都打一跳目录。 */
export async function getCompanyModelCatalog(kind: CompanyModelKind): Promise<CompanyModelCatalog> {
  const hit = cache.get(kind)
  if (hit && hit.expiresAt > Date.now()) return hit.data
  const data = await fetchCompanyModelCatalog(kind)
  cache.set(kind, { expiresAt: Date.now() + CATALOG_TTL_MS, data })
  return data
}

/**
 * 目录默认模型；目录不可用或为空时返回 null（调用方继续走既有兜底链，
 * 不能因为目录一跳失败让全部生成任务直接报错）。
 */
export async function defaultCompanyModel(kind: CompanyModelKind): Promise<string | null> {
  try {
    return (await getCompanyModelCatalog(kind)).defaultModel
  } catch (error) {
    logTaskWarn('AIConfig', 'company-model-catalog-unavailable', {
      kind,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
