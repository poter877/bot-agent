import { queryOptions } from '@tanstack/react-query'
import { api } from '@/shared/api/client'
import { WORKSPACE_SCOPE } from '@/shared/api/query-keys'
import type { CreativeProject } from './model'
export type ToolKind = 'lipsync' | 'rigging' | 'research' | 'stock'
export type ToolProvider = 'sync' | 'meshy' | 'tavily' | 'pexels'
export interface ToolSetting {
  provider: ToolProvider
  enabled: boolean
  configured: boolean
  model: string
}
export interface ToolFile {
  name: string
  url: string
  kind: 'video' | 'model'
  metadata?: { meshes: number; joints: number; animations: number }
}
export interface CreativeModel {
  id: number
  name: string
  url: string
  metadata: { meshes: number; joints: number; animations: number }
}
export interface ToolJob {
  id: number
  kind: ToolKind
  status: 'queued' | 'submitting' | 'running' | 'completed' | 'failed' | 'uncertain'
  progress: number
  remoteId: string | null
  error: string | null
  createdAt: string
  input: { shotId?: string; modelId?: number; query?: string; media?: 'image' | 'video'; height?: number }
  result: {
    files?: ToolFile[]
    articles?: { title: string; url: string; content: string }[]
    candidates?: {
      id: string
      kind: 'image' | 'video'
      title: string
      preview: string
      pageUrl: string
      author: string
      authorUrl: string
      licenseUrl: string
      duration: number | null
    }[]
    imports?: Record<string, string>
    appliedRevision?: number
  }
}
export const toolApi = {
  settings: (signal?: AbortSignal) => api.get<ToolSetting[]>('/creative/tool-settings', { signal }),
  list: (id: number, signal?: AbortSignal) =>
    api.get<{ jobs: ToolJob[]; models: CreativeModel[] }>(`/creative/${id}/tools`, { signal }),
  start: (id: number, revision: number, kind: ToolKind, input: ToolJob['input'], force = false) =>
    api.post<ToolJob>(`/creative/${id}/tools`, { revision, kind, input, force }, { timeoutMs: 180000 }),
  resume: (id: number, jobId: number, remoteId?: string) =>
    api.post<ToolJob>(`/creative/${id}/tools/${jobId}/resume`, { remoteId }),
  apply: (id: number, jobId: number, revision: number) =>
    api.post<CreativeProject>(`/creative/${id}/tools/${jobId}/apply`, { revision }),
  import: (id: number, jobId: number, candidateId: string, revision: number) =>
    api.post<CreativeProject>(
      `/creative/${id}/tools/${jobId}/import`,
      { candidateId, revision },
      { timeoutMs: 360000 },
    ),
  upload: (id: number, file: File) =>
    api.upload<CreativeModel>(`/creative/${id}/models`, file, { timeoutMs: 180000 }),
}
export const toolQueries = {
  settings: () =>
    queryOptions({
      queryKey: ['workspace', WORKSPACE_SCOPE, 'creative-tool-settings'],
      queryFn: ({ signal }) => toolApi.settings(signal),
    }),
  project: (id: number) =>
    queryOptions({
      queryKey: ['workspace', WORKSPACE_SCOPE, 'creative-tools', id],
      queryFn: ({ signal }) => toolApi.list(id, signal),
      refetchInterval: (q) =>
        q.state.data?.jobs.some((j) => ['queued', 'submitting', 'running'].includes(j.status)) ? 3000 : false,
    }),
}
