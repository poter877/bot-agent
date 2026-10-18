/** 生成任务（sys_task，接口直接返回 camelCase）与成片（video_merge，snake_case）模型 */
import { asRecord, field, parseJsonArray } from '@/shared/api/dto'

export type GenerationStatus = 'processing' | 'completed' | 'failed'

/** GET /tasks 系列接口的 drizzle 原始行（camelCase，不经 toSnakeCase） */
export interface SysTask {
  id: number
  type: 'image' | 'video'
  storyboardId: number | null
  dramaId: number | null
  sceneId: number | null
  characterId: number | null
  propId: number | null
  provider: string
  prompt: string
  model: string
  taskId: string
  resultUrl: string
  localPath: string
  status: GenerationStatus
  errorMsg: string
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export function mapSysTask(raw: unknown): SysTask {
  const o = asRecord(raw)
  return {
    id: Number(field(o, 'id') ?? 0),
    type: (field(o, 'type') as SysTask['type']) ?? 'image',
    storyboardId: (field(o, 'storyboard_id') as number | null) ?? null,
    dramaId: (field(o, 'drama_id') as number | null) ?? null,
    sceneId: (field(o, 'scene_id') as number | null) ?? null,
    characterId: (field(o, 'character_id') as number | null) ?? null,
    propId: (field(o, 'prop_id') as number | null) ?? null,
    provider: String(field(o, 'provider') ?? ''),
    prompt: String(field(o, 'prompt') ?? ''),
    model: String(field(o, 'model') ?? ''),
    taskId: String(field(o, 'taskId') ?? ''),
    resultUrl: String(field(o, 'resultUrl') ?? ''),
    localPath: String(field(o, 'localPath') ?? ''),
    status: (field(o, 'status') as GenerationStatus) ?? 'processing',
    errorMsg: String(field(o, 'errorMsg') ?? ''),
    createdAt: String(field(o, 'createdAt') ?? ''),
    updatedAt: String(field(o, 'updatedAt') ?? ''),
    completedAt: (field(o, 'completedAt') as string | null) ?? null,
  }
}

export type MergeStatus = 'pending' | 'processing' | 'completed' | 'failed'

/** video_merge 行（snake_case）；scenes 字段为 JSON 字符串数组 */
export interface VideoMerge {
  id: number
  episodeId: number
  dramaId: number
  title: string
  provider: string
  model: string
  status: MergeStatus
  sources: string[]
  mergedUrl: string
  duration: number
  taskId: string
  errorMsg: string
  createdAt: string
  completedAt: string | null
}

export function mapVideoMerge(raw: unknown): VideoMerge {
  const o = asRecord(raw)
  return {
    id: Number(field(o, 'id') ?? 0),
    episodeId: Number(field(o, 'episode_id') ?? 0),
    dramaId: Number(field(o, 'drama_id') ?? 0),
    title: String(field(o, 'title') ?? ''),
    provider: String(field(o, 'provider') ?? ''),
    model: String(field(o, 'model') ?? ''),
    status: (field(o, 'status') as MergeStatus) ?? 'pending',
    sources: parseJsonArray(field(o, 'scenes')),
    mergedUrl: String(field(o, 'merged_url') ?? ''),
    duration: Number(field(o, 'duration') ?? 0),
    taskId: String(field(o, 'task_id') ?? ''),
    errorMsg: String(field(o, 'error_msg') ?? ''),
    createdAt: String(field(o, 'created_at') ?? ''),
    completedAt: (field(o, 'completed_at') as string | null) ?? null,
  }
}
