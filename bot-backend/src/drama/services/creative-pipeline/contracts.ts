import { z } from 'zod'
import type { CreativeProject } from '../creative-projects.js'
import type { PipelineDefinition, PipelineStage, StageKind } from './definitions.js'
export const narrativeArtifactSchema = z.object({
  summary: z.string().trim().min(1).max(4000),
  content: z.string().trim().min(1).max(40000),
  checks: z.array(z.string().max(1000)).max(30).default([]),
}).strict()
export type PipelineArtifact = z.infer<typeof narrativeArtifactSchema> & { data?: Record<string, unknown> }
export type StageStatus = 'pending' | 'running' | 'waiting' | 'review' | 'completed' | 'failed'
export interface StageState {
  id: StageKind; status: StageStatus; attempt: number; artifact: PipelineArtifact | null
  error: string | null; approvedAt: string | null; startedAt: string | null; completedAt: string | null
  /** 《重构》§6：text 步由本地 Hermes 客户端执行——服务端只准备上下文并等待回交。
   *  非空表示本阶段正在等待客户端 Agent（运行状态为 waiting）。 */
  pendingAgent?: { instructions: string; payload: string; kind?: AgentStageKind } | null
}
export type RunStatus = 'ready' | 'running' | 'pausing' | 'paused' | 'waiting' | 'review' | 'failed' | 'completed' | 'cancelled'
export interface StageContext {
  project: CreativeProject
  definition: PipelineDefinition
  stage: PipelineStage
  artifacts: Record<string, PipelineArtifact>
  previous: PipelineArtifact | null
  retry: boolean
  checkpoint: (artifact: PipelineArtifact, revision?: number) => void
}
export interface StageResult {
  artifact: PipelineArtifact
  waiting?: boolean
  revision?: number
}
export class PipelineInputRequired extends Error {}
/** 服务端无编排车道（HERMES_AGENT_* 已退役）：携带准备好的提示词与上下文，
 *  由 runner 转为 waiting + pendingAgent，等待客户端经宿主会话执行后回交。
 *  kind 决定回交产物的解析方式：narrative（默认）={summary,content,checks}、
 *  plan=创作方案 JSON、translate=字幕译稿数组。 */
export type AgentStageKind = 'narrative' | 'plan' | 'translate'
export class AgentStagePending extends Error {
  constructor(
    public readonly prepared: { instructions: string; payload: string; kind?: AgentStageKind },
  ) {
    super('本阶段需要在桌面 app 中由 AI 完成（服务端不代调模型）')
  }
}
