/** 项目 API：列表/详情/创建/更新/删除（snake_case 请求与响应） */
import { api, qs } from '@/shared/api/client'
import { mapDrama, type CreativeCategory, type ProjectType, type Drama, type DramaListFilters } from './model'

export const dramaApi = {
  async list(filters?: DramaListFilters, signal?: AbortSignal): Promise<{ items: Drama[]; total: number }> {
    const query = qs({
      keyword: filters?.keyword || undefined,
      status: filters?.status || undefined,
    })
    const data = await api.get<unknown>(`/dramas${query}`, { signal })
    const o = (data ?? {}) as { items?: unknown[]; pagination?: { total?: number } }
    const items = Array.isArray(o.items) ? o.items.map(mapDrama) : []
    return { items, total: Number(o.pagination?.total ?? items.length) }
  },

  async get(id: number, signal?: AbortSignal): Promise<Drama> {
    return mapDrama(await api.get<unknown>(`/dramas/${id}`, { signal }))
  },

  create(data: { title: string; style?: string; aspect_ratio?: string; description?: string; genre?: string; project_type?: ProjectType; creative_category?: CreativeCategory; film_style?: string; topic?: string; language?: string; duration_sec?: number; has_voice?: boolean }): Promise<unknown> {
    return api.post('/dramas', data)
  },

  update(id: number, data: Record<string, unknown>): Promise<null> {
    return api.put(`/dramas/${id}`, data)
  },

  del(id: number): Promise<null> {
    return api.del(`/dramas/${id}`)
  },
}
