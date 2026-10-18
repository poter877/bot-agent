/** 资产 API（角色/场景/道具）：CRUD + 最终提示词生成 + 生图受理 */
import { api } from '@/shared/api/client'
import type { AssetKind } from './model'

export interface GenerateImageParams {
  episodeId: number
  model?: string
  configId?: number
  textModel?: string
  textConfigId?: number
}

interface AssetApiShape {
  create: (data: Record<string, unknown>) => Promise<unknown>
  update: (id: number, data: Record<string, unknown>) => Promise<null>
  del: (id: number) => Promise<null>
  generatePrompt: (id: number, episodeId: number, force?: boolean, textModel?: string, textConfigId?: number) => Promise<{ final_prompt?: string }>
  generateImage: (id: number, p: GenerateImageParams) => Promise<{ image_generation_id?: number }>
}

const promptBody = (episodeId: number, force: boolean, textModel?: string, textConfigId?: number) => ({
  episode_id: episodeId,
  force,
  text_model: textModel || undefined,
  text_config_id: textConfigId || undefined,
})

const imageBody = (p: GenerateImageParams) => ({
  episode_id: p.episodeId,
  model: p.model || undefined,
  config_id: p.configId || undefined,
  text_model: p.textModel || undefined,
  text_config_id: p.textConfigId || undefined,
})

export const characterApi: AssetApiShape = {
  create: (data) => api.post('/characters', data),
  update: (id, data) => api.put(`/characters/${id}`, data),
  del: (id) => api.del(`/characters/${id}`),
  generatePrompt: (id, episodeId, force = false, textModel, textConfigId) =>
    api.post(`/characters/${id}/generate-prompt`, promptBody(episodeId, force, textModel, textConfigId)),
  generateImage: (id, p) => api.post(`/characters/${id}/generate-image`, imageBody(p)),
}

export const sceneApi: AssetApiShape = {
  create: (data) => api.post('/scenes', data),
  update: (id, data) => api.put(`/scenes/${id}`, data),
  del: (id) => api.del(`/scenes/${id}`),
  generatePrompt: (id, episodeId, force = false, textModel, textConfigId) =>
    api.post(`/scenes/${id}/generate-prompt`, promptBody(episodeId, force, textModel, textConfigId)),
  generateImage: (id, p) => api.post(`/scenes/${id}/generate-image`, imageBody(p)),
}

export const propApi: AssetApiShape = {
  create: (data) => api.post('/props', data),
  update: (id, data) => api.put(`/props/${id}`, data),
  del: (id) => api.del(`/props/${id}`),
  generatePrompt: (id, episodeId, force = false, textModel, textConfigId) =>
    api.post(`/props/${id}/generate-prompt`, promptBody(episodeId, force, textModel, textConfigId)),
  generateImage: (id, p) => api.post(`/props/${id}/generate-image`, imageBody(p)),
}

/** 角色批量生图（仅角色提供批量接口） */
export function batchCharacterImages(
  ids: number[],
  p: GenerateImageParams,
): Promise<{ count: number; ids: number[] }> {
  return api.post('/characters/batch-generate-images', {
    character_ids: ids,
    episode_id: p.episodeId,
    model: p.model || undefined,
    config_id: p.configId || undefined,
    text_model: p.textModel || undefined,
    text_config_id: p.textConfigId || undefined,
  })
}

export function assetApiOf(kind: AssetKind): AssetApiShape {
  return kind === 'character' ? characterApi : kind === 'scene' ? sceneApi : propApi
}
