/** 设置域 API：风格预设、存储、内容语言、服务器更新 */
import { api } from '@/shared/api/client'
import { asRecord, field } from '@/shared/api/dto'

export interface StylePreset {
  id: number
  name: string
  value: string
  prompt: string
  description: string
  sortOrder: number
  isActive: boolean
}

export function mapStylePreset(raw: unknown): StylePreset {
  const o = asRecord(raw)
  return {
    id: Number(field(o, 'id') ?? 0),
    name: String(field(o, 'name') ?? ''),
    value: String(field(o, 'value') ?? ''),
    prompt: String(field(o, 'prompt') ?? ''),
    description: String(field(o, 'description') ?? ''),
    sortOrder: Number(field(o, 'sort_order') ?? 0),
    isActive: !!field(o, 'is_active'),
  }
}

export const stylePresetApi = {
  async list(all = false, signal?: AbortSignal): Promise<StylePreset[]> {
    const rows = await api.get<unknown[]>(`/style-presets${all ? '?all=1' : ''}`, { signal })
    return (Array.isArray(rows) ? rows : []).map(mapStylePreset)
  },
  create(data: { name: string; value: string; prompt: string; description?: string; sort_order?: number; is_active?: boolean }) {
    return api.post('/style-presets', data)
  },
  update(id: number, data: Record<string, unknown>) {
    return api.put(`/style-presets/${id}`, data)
  },
  del(id: number) {
    return api.del(`/style-presets/${id}`)
  },
}

/** GET /storage 返回 camelCase */
export interface StorageInfo {
  mode: 'desktop' | 'server'
  dataDir: string
  storageRoot: string
  sqlitePath: string
  usage: { db: number; images: number; videos: number; merged: number; uploads: number; temp: number; other: number; total: number }
  usageStale: boolean
  computedAt: string | null
  freeBytes: number | null
}

export const storageApi = {
  info(signal?: AbortSignal): Promise<StorageInfo> {
    return api.get<StorageInfo>('/storage', { signal })
  },
}

export const settingsApi = {
  contentLanguage: (signal?: AbortSignal) => api.get<{ language: string }>('/settings/content-language', { signal }),
  setContentLanguage: (language: string) => api.put('/settings/content-language', { language }),
}

/** 服务器/Docker 部署的版本检查与更新（桌面版走桌面桥，不用此 API） */
export interface ServerUpdateState {
  status: 'idle' | 'up-to-date' | 'available' | 'error'
  currentVersion: string
  latestVersion?: string
  notes?: string
  error?: string
  updateMode: 'watchtower' | 'manual'
}

export const serverUpdateApi = {
  state: (signal?: AbortSignal) => api.get<ServerUpdateState>('/server-update/state', { signal }),
  check: () => api.post<ServerUpdateState>('/server-update/check'),
  apply: () => api.post('/server-update/apply'),
}
