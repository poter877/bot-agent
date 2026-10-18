/** 分镜 API：创建/更新/删除；字段编辑支持 snake/camel 双写（旧 toField 语义） */
import { api } from '@/shared/api/client'
import type { Storyboard } from './model'

export const storyboardApi = {
  create(data: {
    episode_id: number
    storyboard_number?: number
    title?: string
    description?: string
    scene_id?: number | null
    duration?: number
    character_ids?: number[]
    prop_ids?: number[]
  }): Promise<unknown> {
    return api.post('/storyboards', data)
  },

  update(id: number, data: Record<string, unknown>): Promise<null> {
    return api.put(`/storyboards/${id}`, data)
  },

  del(id: number): Promise<null> {
    return api.del(`/storyboards/${id}`)
  },
}

/** 兼容分镜列表行的静态类型（queries 使用） */
export type StoryboardRow = Storyboard
