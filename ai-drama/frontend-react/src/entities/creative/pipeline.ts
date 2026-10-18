import { queryOptions } from '@tanstack/react-query'
import { api } from '@/shared/api/client'
import type { ToolboxFile } from './toolbox'
export interface PipelineStage {
  id: string
  title: string
  instruction: string
  review: boolean
  produces: string[]
  requires: string[]
}
export interface PipelineDefinition {
  id: string
  category: string
  title: string
  version: number
  delivery: 'movie' | 'clips'
  stages: PipelineStage[]
}
export type PipelineToolRole =
  | 'analysis'
  | 'research'
  | 'visual'
  | 'voice'
  | 'music'
  | 'post'
  | 'model'
  | 'delivery'
  | 'interactive'
export interface PipelineToolStep {
  key: string
  toolId: string
  stage: string
  phase: 'before' | 'after'
  role: PipelineToolRole
  reason: string
  args: Record<string, unknown>
  dependsOn: string[]
  shotId?: string
  sourceId?: string
  configId?: number
  apply?: {
    target:
      | 'shot'
      | 'source'
      | 'music'
      | 'narration'
      | 'transcript'
      | 'model'
      | 'artifact'
      | 'delivery'
      | 'render'
    kind?: ToolboxFile['kind']
    shotId?: string
    sourceId?: string
    name?: string
  }
}
export interface PipelineToolExecution extends PipelineToolStep {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'uncertain' | 'skipped'
  jobId?: number
  progress?: number
  remoteId?: string | null
  error?: string | null
  files?: ToolboxFile[]
  data?: Record<string, unknown>
  resolvedArgs?: Record<string, unknown>
  appliedRevision?: number
  writeback?: string
}
export interface PipelineToolRuntime {
  version: 1
  steps: PipelineToolExecution[]
}
export interface PipelineToolPolicy {
  toolId: string
  mode: 'default' | 'selectable' | 'interactive'
  role: PipelineToolRole
  stages: string[]
  categories: string[]
  purpose: string
  selectionKey?: string
}
export interface PipelineToolPlan {
  steps: PipelineToolStep[]
  policies: PipelineToolPolicy[]
  issues?: { stage: string; message: string }[]
}
export interface PipelineAutomation {
  visual?: 'auto' | 'generated' | 'diagram' | 'math' | 'character' | 'threejs' | 'blender' | 'source'
  analysis?: 'auto' | 'off' | 'vision'
  stockTool?: string
  researchTool?: string
  musicTool?: string
  speechTool?: string
  transcriptionTool?: string
  avatarTool?: string
  imageTool?: string
  videoTool?: string
  modelTool?: string
  postTools?: string[]
  toolParameters?: Record<string, Record<string, unknown>>
  capture?: boolean
}
export interface PipelineArtifact {
  summary: string
  content: string
  checks: string[]
  data?: Record<string, unknown>
}
export interface PipelineStageState {
  id: string
  status: string
  attempt: number
  artifact: PipelineArtifact | null
  error: string | null
  approvedAt: string | null
  startedAt: string | null
  completedAt: string | null
}
export interface PipelineRun {
  id: number
  projectId: number
  definition: PipelineDefinition
  revision: number
  version: number
  status: string
  cursor: number
  stages: PipelineStageState[]
  error: string | null
  createdAt: string
  updatedAt: string
  stale: boolean
}
export interface PipelineState {
  definition: PipelineDefinition | null
  run: PipelineRun | null
  history: { id: number; status: string; createdAt: string; revision: number }[]
  events: { id: number; stageId: string | null; kind: string; createdAt: string; payload: unknown }[]
}
export type PipelineAction = 'continue' | 'retry' | 'pause' | 'approve' | 'rewind' | 'sync' | 'cancel'
export const pipelineApi = {
  get: (id: number, signal?: AbortSignal) => api.get<PipelineState>(`/creative/${id}/pipeline`, { signal }),
  run: (id: number, runId: number) => api.get<PipelineRun>(`/creative/${id}/pipeline/runs/${runId}`),
  toolPlan: (id: number, signal?: AbortSignal) =>
    api.get<PipelineToolPlan>(`/creative/${id}/pipeline/tool-plan`, { signal }),
  resumeTool: (
    id: number,
    runId: number,
    jobId: number,
    input: { version: number; remoteId?: string; retrySubmission?: boolean },
  ) => api.post<PipelineState>(`/creative/${id}/pipeline/${runId}/tools/${jobId}/resume`, input),
  capabilities: (id: number) =>
    api.get<{ id: string; title: string; available: boolean; detail: string }[]>(
      `/creative/${id}/pipeline/capabilities`,
    ),
  start: (id: number, revision: number) => api.post<PipelineState>(`/creative/${id}/pipeline`, { revision }),
  action: (
    id: number,
    runId: number,
    input: {
      version: number
      action: PipelineAction
      stageId?: string
      edited?: { summary: string; content: string; checks: string[] }
    },
  ) => api.post<PipelineState>(`/creative/${id}/pipeline/${runId}/actions`, input),
}
export const pipelineQueries = {
  toolPlan: (id: number, revision: number) =>
    queryOptions({
      queryKey: ['creative-pipeline-tool-plan', id, revision] as const,
      queryFn: ({ signal }) => pipelineApi.toolPlan(id, signal),
      enabled: Number.isInteger(id) && id > 0,
      staleTime: 1000,
    }),
  detail: (id: number) =>
    queryOptions({
      queryKey: ['creative-pipeline', id] as const,
      queryFn: ({ signal }) => pipelineApi.get(id, signal),
      enabled: Number.isInteger(id) && id > 0,
      staleTime: 1000,
      refetchInterval: (query) =>
        ['running', 'pausing', 'waiting'].includes(query.state.data?.run?.status ?? '') ? 2000 : false,
    }),
}
