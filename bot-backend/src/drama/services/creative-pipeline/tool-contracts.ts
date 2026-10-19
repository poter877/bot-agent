import type { CreativeCategory } from '../creative-catalog.js'
import type { ToolFileKind } from '../production-tools/contracts.js'
import type { StageKind } from './definitions.js'

export type PipelineToolPhase = 'before' | 'after'
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
export interface PipelineToolReference {
  $step: string
  kind?: ToolFileKind
  index?: number
  dataPath?: string
}
export interface PipelineToolStep {
  key: string
  toolId: string
  stage: StageKind
  phase: PipelineToolPhase
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
    kind?: ToolFileKind
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
  files?: { url: string; name: string; kind: ToolFileKind }[]
  data?: Record<string, unknown>
  resolvedArgs?: Record<string, unknown>
  appliedRevision?: number
  writeback?: string
  applying?: {
    revision: number
    fileUrl: string
    target: NonNullable<PipelineToolStep['apply']>['target']
    shotId?: string
    sourceId?: string
    approval: boolean
    unchangedHash: string
    expectedDuration?: number
  }
}
export interface PipelineToolRuntime {
  version: 1
  steps: PipelineToolExecution[]
}
export interface PipelineToolPolicy {
  toolId: string
  mode: 'default' | 'selectable' | 'interactive'
  role: PipelineToolRole
  stages: StageKind[]
  categories: CreativeCategory[]
  purpose: string
  selectionKey?: string
}
