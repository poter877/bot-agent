import { queryOptions } from '@tanstack/react-query'
import { api } from '@/shared/api/client'
import { WORKSPACE_SCOPE } from '@/shared/api/query-keys'
import type { CreativeProject } from './model'

export interface ToolboxInput {
  key: string
  label: string
  type: 'text' | 'number' | 'boolean' | 'select' | 'media' | 'json'
  required?: boolean
  default?: unknown
  options?: { label: string; value: string }[]
  accept?: string
}
export interface ToolboxDefinition {
  id: string
  name: string
  category: string
  provider: string
  description: string
  serviceType?: string
  inputs: ToolboxInput[]
  available: boolean
  implemented?: boolean
  reason?: string
}
export interface ToolboxProvider {
  provider: string
  serviceType: string
  name: string
  baseUrl: string
  models: string[]
  requiresApiKey?: boolean
}
export interface ToolboxCatalog {
  tools: ToolboxDefinition[]
  providers: ToolboxProvider[]
}
export interface ToolboxFile {
  url: string
  name: string
  kind: 'image' | 'video' | 'audio' | 'subtitle' | 'model' | 'archive' | 'data'
}
export interface ToolboxJob {
  id: number
  toolId: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'uncertain' | 'cancelled'
  progress: number
  remoteId?: string | null
  input: { toolId: string; args: Record<string, unknown>; configId?: number }
  result: { summary?: string; files?: ToolboxFile[]; data?: unknown } | null
  error: string | null
  createdAt: string
  updatedAt: string
}
export const toolboxApi = {
  catalog: (signal?: AbortSignal) => api.get<ToolboxCatalog>('/creative/toolbox/catalog', { signal }),
  list: (projectId: number, signal?: AbortSignal) => api.get<ToolboxJob[]>(`/creative/${projectId}/toolbox`, { signal }),
  start: (projectId: number, revision: number, toolId: string, args: Record<string, unknown>, configId?: number) =>
    api.post<ToolboxJob>(`/creative/${projectId}/toolbox`, { revision, toolId, args, ...(configId ? { configId } : {}) }),
  resume: (projectId: number, jobId: number, remoteId?: string, retrySubmission = false) =>
    api.post<ToolboxJob>(`/creative/${projectId}/toolbox/${jobId}/resume`, { remoteId, ...(retrySubmission ? { retrySubmission: true } : {}) }),
  cancel: (projectId: number, jobId: number) => api.post<ToolboxJob>(`/creative/${projectId}/toolbox/${jobId}/cancel`, {}),
  apply: (projectId: number, jobId: number, revision: number, input: { fileUrl?: string; shotId?: string; sourceId?: string; sourceName?: string }) =>
    api.post<CreativeProject>(`/creative/${projectId}/toolbox/${jobId}/apply`, { revision, ...input }),
  upload: (projectId: number, file: File) => api.upload<ToolboxFile>(`/creative/${projectId}/toolbox/upload`, file, { timeoutMs: 180000 }),
}
export const toolboxQueries = {
  catalog: () => queryOptions({
    queryKey: ['workspace', WORKSPACE_SCOPE, 'creative-toolbox-catalog'],
    queryFn: ({ signal }) => toolboxApi.catalog(signal),
    staleTime: 30_000,
  }),
  project: (projectId: number) => queryOptions({
    queryKey: ['workspace', WORKSPACE_SCOPE, 'creative-toolbox', projectId],
    queryFn: ({ signal }) => toolboxApi.list(projectId, signal),
    refetchInterval: (query) => query.state.data?.some(job => job.status === 'queued' || job.status === 'running') ? 3000 : false,
  }),
}

/** Form values are kept separate from query data, including JSON the user is still editing. */
export function toolboxDefaults(tool: ToolboxDefinition): Record<string, unknown> {
  return Object.fromEntries(tool.inputs.map(input => [input.key,
    input.type === 'json' && input.default !== undefined ? JSON.stringify(input.default, null, 2)
      : input.default ?? (input.type === 'boolean' ? false : ''),
  ]))
}
export function toolboxArguments(tool: ToolboxDefinition, values: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const field of tool.inputs) {
    const value = values[field.key]
    const empty = value === '' || value === undefined || value === null || (typeof value === 'string' && !value.trim())
    if (empty) {
      if (field.required) throw new Error(`请填写${field.label}`)
      continue
    }
    if (field.type === 'number') {
      const number = Number(value)
      if (!Number.isFinite(number)) throw new Error(`${field.label}需要有效数字`)
      result[field.key] = number
    } else if (field.type === 'json') {
      try { result[field.key] = typeof value === 'string' ? JSON.parse(value) : value }
      catch { throw new Error(`${field.label}的 JSON 格式不正确`) }
    } else if (field.type === 'boolean') result[field.key] = value === true
    else if (field.type === 'select' && field.options && !field.options.some(option => String(option.value) === String(value))) {
      throw new Error(`请重新选择${field.label}`)
    } else result[field.key] = value
  }
  return result
}
