/** film-pipeline 阶段产物契约与运行视图。 */
import { z } from 'zod'

export const filmArtifactSchema = z.object({
  summary: z.string().trim().min(1).max(4000),
  content: z.string().trim().min(1).max(120000),
  checks: z.array(z.string().max(1000)).max(30).default([]),
}).strict()
export type FilmArtifact = z.infer<typeof filmArtifactSchema> & { data?: Record<string, unknown> }

export type FilmStageStatus = 'pending' | 'running' | 'review' | 'waiting' | 'completed' | 'failed'
export type FilmRunStatus =
  | 'ready'
  | 'running'
  | 'review'
  | 'waiting'
  | 'paused'
  | 'failed'
  | 'completed'
  | 'cancelled'

export interface FilmStageState {
  id: string
  status: FilmStageStatus
  attempt: number
  artifact: FilmArtifact | null
  error: string | null
  approvedAt: string | null
  completedAt: string | null
}

export interface FilmRunView {
  id: number
  projectId: number
  status: FilmRunStatus
  cursor: number
  stages: FilmStageState[]
  error: string | null
}

export class FilmError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}
