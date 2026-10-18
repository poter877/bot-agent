/** 生成任务与拼接 API。注意：/tasks 系列返回 camelCase 原始行。 */
import { api } from '@/shared/api/client'
import { mapSysTask, mapVideoMerge, type SysTask, type VideoMerge } from './model'

export type { SysTask, VideoMerge }

export const taskApi = {
  /** 发起图片/视频生成；受理返回 sys_task 行（含本系统 id，用于轮询） */
  generate(data: Record<string, unknown>, signal?: AbortSignal): Promise<SysTask> {
    return api.post<unknown>('/tasks', data, { signal }).then(mapSysTask)
  },

  get(id: number, signal?: AbortSignal): Promise<SysTask | null> {
    return api.get<unknown>(`/tasks/${id}`, { signal }).then((row) => (row ? mapSysTask(row) : null))
  },

  del(id: number): Promise<null> {
    return api.del(`/tasks/${id}`)
  },

  /** 按类型/分镜/项目过滤任务列表（分镜视频历史用） */
  async list(
    params: { type?: 'image' | 'video'; drama_id?: number; storyboard_id?: number },
    signal?: AbortSignal,
  ): Promise<SysTask[]> {
    const query = new URLSearchParams()
    if (params.type) query.set('type', params.type)
    if (params.drama_id) query.set('drama_id', String(params.drama_id))
    if (params.storyboard_id) query.set('storyboard_id', String(params.storyboard_id))
    const s = query.toString()
    const rows = await api.get<unknown[]>(`/tasks${s ? `?${s}` : ''}`, { signal })
    return (Array.isArray(rows) ? rows : []).map(mapSysTask)
  },
}

export const mergeApi = {
  /** 发起 ffmpeg 拼接（异步）；无可用视频/ffmpeg 异常 → 400 */
  merge(episodeId: number, storyboardIds?: number[]): Promise<{ merge_id: number; status: string }> {
    return api.post(`/merge/episodes/${episodeId}/merge`, storyboardIds?.length ? { storyboard_ids: storyboardIds } : {})
  },

  /** 最新一条拼接记录（可能为 null） */
  status(episodeId: number, signal?: AbortSignal): Promise<VideoMerge | null> {
    return api.get<unknown>(`/merge/episodes/${episodeId}/merge`, { signal }).then((row) => (row ? mapVideoMerge(row) : null))
  },

  list(episodeId: number, signal?: AbortSignal): Promise<VideoMerge[]> {
    return api
      .get<unknown[]>(`/merge/episodes/${episodeId}/merges`, { signal })
      .then((rows) => (Array.isArray(rows) ? rows.map(mapVideoMerge) : []))
  },
}

export interface EpisodeJobs {
  tasks: ReturnType<typeof mapSysTask>[]
  merges: ReturnType<typeof mapVideoMerge>[]
}

/** 按集聚合生成任务（sys_task + video_merges，倒序）— 工作台统一同步来源 */
export async function fetchEpisodeJobs(episodeId: number, signal?: AbortSignal): Promise<EpisodeJobs> {
  const data = await api.get<{ tasks?: unknown[]; merges?: unknown[] }>(`/episodes/${episodeId}/generation-tasks`, { signal })
  return {
    tasks: (Array.isArray(data.tasks) ? data.tasks : []).map(mapSysTask),
    merges: (Array.isArray(data.merges) ? data.merges : []).map(mapVideoMerge),
  }
}
