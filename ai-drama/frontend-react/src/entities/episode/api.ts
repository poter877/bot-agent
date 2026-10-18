/** 集 API：CRUD、单集资产、提取/批量提示词任务、pipeline 状态 */
import { api } from '@/shared/api/client'
import { mapCharacter, mapProp, mapScene, type Character, type Prop, type Scene } from '@/entities/asset/model'
import type { ExtractStatus, VideoPromptsStatus } from './task-types'

export const episodeApi = {
  create(data: { drama_id: number; title?: string; resolution?: string }): Promise<{ id: number; episode_number: number }> {
    return api.post('/episodes', data)
  },

  update(id: number, data: Record<string, unknown>): Promise<null> {
    return api.put(`/episodes/${id}`, data)
  },

  del(id: number): Promise<null> {
    return api.del(`/episodes/${id}`)
  },

  async characters(id: number, signal?: AbortSignal): Promise<Character[]> {
    return (await api.get<unknown[]>(`/episodes/${id}/characters`, { signal })).map(mapCharacter)
  },
  async scenes(id: number, signal?: AbortSignal): Promise<Scene[]> {
    return (await api.get<unknown[]>(`/episodes/${id}/scenes`, { signal })).map(mapScene)
  },
  async props(id: number, signal?: AbortSignal): Promise<Prop[]> {
    return (await api.get<unknown[]>(`/episodes/${id}/props`, { signal })).map(mapProp)
  },

  /** 无 GET /episodes/:id 详情接口：工作台经项目详情按 episode_number 定位 episodeId */

  async extract(
    id: number,
    target: 'characters' | 'scenes' | 'props',
    model?: string,
    configId?: number,
  ): Promise<{ target: string; status: string; already_running: boolean }> {
    return api.post(`/episodes/${id}/extract`, {
      target,
      model: model || undefined,
      config_id: configId || undefined,
    })
  },

  extractStatus(id: number, signal?: AbortSignal): Promise<ExtractStatus> {
    return api.get<ExtractStatus>(`/episodes/${id}/extract-status`, { signal })
  },

  generateVideoPrompts(
    id: number,
    opts?: { model?: string; configId?: number; storyboardIds?: number[] },
  ): Promise<{ status: string; total?: number; already_running?: boolean }> {
    return api.post(`/episodes/${id}/generate-video-prompts`, {
      model: opts?.model || undefined,
      config_id: opts?.configId || undefined,
      storyboard_ids: opts?.storyboardIds?.length ? opts.storyboardIds : undefined,
    })
  },

  videoPromptsStatus(id: number, signal?: AbortSignal): Promise<VideoPromptsStatus | null> {
    return api.get<VideoPromptsStatus | null>(`/episodes/${id}/video-prompts-status`, { signal })
  },

  async storyboards(id: number, signal?: AbortSignal) {
    const { mapStoryboard } = await import('@/entities/storyboard/model')
    const rows = await api.get<unknown[]>(`/episodes/${id}/storyboards`, { signal })
    return rows.map(mapStoryboard)
  },
}
