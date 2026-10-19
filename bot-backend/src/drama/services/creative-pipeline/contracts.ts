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
