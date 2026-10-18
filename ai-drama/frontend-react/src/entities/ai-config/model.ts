/** AI 服务配置（ai_service_configs）：列表/CRUD/连通性测试；含模型标签编辑的 payload 形状 */
import { api, qs } from '@/shared/api/client'
import { asArray, asRecord, field } from '@/shared/api/dto'

/** Capability names are supplied by the backend tool catalog as adapters are added. */
export type ServiceType = string

export interface AiConfig {
  id: number
  serviceType: ServiceType
  provider: string
  name: string
  baseUrl: string
  /** 密钥仅用于提交，不从服务端读取。 */
  hasApiKey?: boolean
  apiKey: string
  models: string[]
  endpoint: string
  queryEndpoint: string
  priority: number
  isDefault: boolean
  isActive: boolean
  temperature: number | null
  serviceOptions?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export function mapAiConfig(raw: unknown): AiConfig {
  const o = asRecord(raw)
  const models = field<unknown>(o, 'model')
  let modelList: string[] = []
  if (Array.isArray(models)) modelList = models.map(String)
  else if (typeof models === 'string' && models) {
    try {
      const parsed = JSON.parse(models)
      modelList = Array.isArray(parsed) ? parsed.map(String) : [String(models)]
    } catch {
      modelList = models
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
    }
  }
  return {
    id: Number(field(o, 'id') ?? 0),
    serviceType: (field(o, 'service_type') as ServiceType) ?? 'text',
    provider: String(field(o, 'provider') ?? ''),
    name: String(field(o, 'name') ?? ''),
    baseUrl: String(field(o, 'base_url') ?? ''),
    apiKey: '',
    hasApiKey: !!field(o, 'has_api_key'),
    models: modelList,
    endpoint: String(field(o, 'endpoint') ?? ''),
    queryEndpoint: String(field(o, 'query_endpoint') ?? ''),
    priority: Number(field(o, 'priority') ?? 0),
    isDefault: !!field(o, 'is_default'),
    isActive: !!field(o, 'is_active'),
    temperature: (field(o, 'temperature') as number | null) ?? null,
    serviceOptions: asRecord(field(o, 'service_options')),
    createdAt: String(field(o, 'created_at') ?? ''),
    updatedAt: String(field(o, 'updated_at') ?? ''),
  }
}

export interface ConfigTestResult {
  checked?: 'configuration'
  ok: boolean
  reachable: boolean
  status?: number
  statusText?: string
  method?: string
  url?: string
  message?: string
  responsePreview?: string
}

export const aiConfigApi = {
  async list(serviceType?: ServiceType, signal?: AbortSignal): Promise<AiConfig[]> {
    const rows = await api.get<unknown[]>(`/ai-configs${serviceType ? qs({ service_type: serviceType }) : ''}`, { signal })
    return asArray(rows).map(mapAiConfig)
  },

  create(data: Record<string, unknown>): Promise<unknown> {
    return api.post('/ai-configs', data)
  },

  update(id: number, data: Record<string, unknown>): Promise<null> {
    return api.put(`/ai-configs/${id}`, data)
  },

  del(id: number): Promise<null> {
    return api.del(`/ai-configs/${id}`)
  },

  test(data: Record<string, unknown>): Promise<ConfigTestResult> {
    return api.post('/ai-configs/test', data)
  },

  /** 公司模型目录（后端注入服务令牌转发 bot-backend；kind 缺省为 text） */
  async companyModels(kind: CompanyModelKind = 'text', signal?: AbortSignal): Promise<CompanyModelCatalog> {
    const raw = await api.get<unknown>(`/ai-configs/company-models${qs({ kind })}`, { signal })
    return mapCompanyModelCatalog(raw)
  },
}

/** 公司模型目录（bot-backend 唯一真相源）：kind 对应五类核心服务 */
export type CompanyModelKind = 'text' | 'image' | 'video' | 'speech' | 'transcription'

export interface CompanyModelEntry {
  id: string
  displayName: string
}

export interface CompanyModelCatalog {
  models: CompanyModelEntry[]
  defaultModel: string | null
}

/** 解析 /ai-configs/company-models?kind= 代理返回的目录（兼容旧的裸 id 数组形态） */
export function mapCompanyModelCatalog(raw: unknown): CompanyModelCatalog {
  if (Array.isArray(raw)) {
    const legacy = raw.map(String).filter(Boolean).map((id) => ({ id, displayName: id }))
    return { models: legacy, defaultModel: legacy[0]?.id ?? null }
  }
  const o = asRecord(raw)
  const models = asArray(field(o, 'models'))
    .map((item) => {
      const entry = asRecord(item)
      const id = String(field(entry, 'id') ?? '')
      const displayName = String(field(entry, 'displayName') ?? id)
      return id ? { id, displayName } : null
    })
    .filter((entry): entry is CompanyModelEntry => !!entry)
  const declared = field(o, 'defaultModel')
  const defaultModel = typeof declared === 'string' && models.some((m) => m.id === declared) ? declared : (models[0]?.id ?? null)
  return { models, defaultModel }
}

/** 厂商预设（ai_service_providers，含 preset_models） */
export interface AiProvider {
  id: number
  name: string
  displayName: string
  serviceType: string
  provider: string
  defaultUrl: string
  presetModels: string[]
  description: string
  isActive: boolean
}

export const aiProviderApi = {
  async list(signal?: AbortSignal): Promise<AiProvider[]> {
    const rows = await api.get<unknown[]>('/ai-providers', { signal })
    return asArray(rows).map((o) => ({
      id: Number(field(o, 'id') ?? 0),
      name: String(field(o, 'name') ?? ''),
      displayName: String(field(o, 'display_name') ?? ''),
      serviceType: String(field(o, 'service_type') ?? ''),
      provider: String(field(o, 'provider') ?? ''),
      defaultUrl: String(field(o, 'default_url') ?? ''),
      presetModels: asArray(field(o, 'preset_models')).map(String),
      description: String(field(o, 'description') ?? ''),
      isActive: !!field(o, 'is_active'),
    }))
  },
}
