/** 单集资源与任务查询（queryKey 以数据库 episodeId 为锚点） */
import { queryOptions } from '@tanstack/react-query'
import { qk } from '@/shared/api/query-keys'
import { episodeApi } from './api'
import { mapExtractStatus, mapVideoPromptsStatus } from './task-types'
import { fetchEpisodeJobs } from '@/entities/generation-task/api'
import { mergeApi } from '@/entities/generation-task/api'

export const episodeQueries = {
  characters: (episodeId: number) =>
    queryOptions({
      queryKey: qk.episodeResource(episodeId, 'characters'),
      queryFn: ({ signal }) => episodeApi.characters(episodeId, signal),
      enabled: episodeId > 0,
      staleTime: 10_000,
    }),
  scenes: (episodeId: number) =>
    queryOptions({
      queryKey: qk.episodeResource(episodeId, 'scenes'),
      queryFn: ({ signal }) => episodeApi.scenes(episodeId, signal),
      enabled: episodeId > 0,
      staleTime: 10_000,
    }),
  props: (episodeId: number) =>
    queryOptions({
      queryKey: qk.episodeResource(episodeId, 'props'),
      queryFn: ({ signal }) => episodeApi.props(episodeId, signal),
      enabled: episodeId > 0,
      staleTime: 10_000,
    }),
  storyboards: (episodeId: number) =>
    queryOptions({
      queryKey: qk.episodeResource(episodeId, 'storyboards'),
      queryFn: ({ signal }) => episodeApi.storyboards(episodeId, signal),
      enabled: episodeId > 0,
      staleTime: 10_000,
    }),
  /** 聚合任务（sys_task + merges）：工作台唯一轮询同步入口 */
  jobs: (episodeId: number, opts: { routeActive: boolean; localBackend: boolean }) =>
    queryOptions({
      queryKey: qk.episodeJobs(episodeId),
      queryFn: ({ signal }) => fetchEpisodeJobs(episodeId, signal),
      enabled: opts.routeActive && episodeId > 0,
      staleTime: 0,
      retry: false,
      networkMode: opts.localBackend ? 'always' : 'online',
      refetchOnWindowFocus: 'always',
      refetchOnReconnect: 'always',
    }),
  merges: (episodeId: number) =>
    queryOptions({
      queryKey: qk.merges(episodeId),
      queryFn: ({ signal }) => mergeApi.list(episodeId, signal),
      enabled: episodeId > 0,
      staleTime: 10_000,
    }),
  extractStatus: (episodeId: number) =>
    queryOptions({
      queryKey: qk.extractStatus(episodeId),
      queryFn: async ({ signal }) => mapExtractStatus(await episodeApi.extractStatus(episodeId, signal)),
      enabled: episodeId > 0,
      staleTime: 0,
    }),
  videoPromptsStatus: (episodeId: number) =>
    queryOptions({
      queryKey: qk.promptBatch(episodeId),
      queryFn: async ({ signal }) => mapVideoPromptsStatus(await episodeApi.videoPromptsStatus(episodeId, signal)),
      enabled: episodeId > 0,
      staleTime: 0,
    }),
}
