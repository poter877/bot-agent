/** 提取/批量提示词任务协议（进程内存态；null = 未启动，无 pending） */
import { asRecord, field } from '@/shared/api/dto'

export interface ExtractTask {
  status: 'running' | 'done' | 'error'
  startedAt: string
  finishedAt?: string
  error?: string
}

export interface ExtractStatus {
  characters: ExtractTask | null
  scenes: ExtractTask | null
  props: ExtractTask | null
}

export interface VideoPromptsStatus {
  status: 'running' | 'done' | 'error'
  total: number
  completed: number
  failed: number
  currentStoryboardId?: number
  startedAt: string
  finishedAt?: string
  error?: string
}

export function mapExtractTask(raw: unknown): ExtractTask | null {
  if (!raw) return null
  const o = asRecord(raw)
  return {
    status: (field(o, 'status') as ExtractTask['status']) ?? 'running',
    startedAt: String(field(o, 'started_at') ?? ''),
    finishedAt: field<string | undefined>(o, 'finished_at'),
    error: field<string | undefined>(o, 'error'),
  }
}

export function mapExtractStatus(raw: unknown): ExtractStatus {
  const o = asRecord(raw)
  return {
    characters: mapExtractTask(field(o, 'characters')),
    scenes: mapExtractTask(field(o, 'scenes')),
    props: mapExtractTask(field(o, 'props')),
  }
}

export function mapVideoPromptsStatus(raw: unknown): VideoPromptsStatus | null {
  if (!raw) return null
  const o = asRecord(raw)
  return {
    status: (field(o, 'status') as VideoPromptsStatus['status']) ?? 'running',
    total: Number(field(o, 'total') ?? 0),
    completed: Number(field(o, 'completed') ?? 0),
    failed: Number(field(o, 'failed') ?? 0),
    currentStoryboardId: field<number | undefined>(o, 'current_storyboard_id'),
    startedAt: String(field(o, 'started_at') ?? ''),
    finishedAt: field<string | undefined>(o, 'finished_at'),
    error: field<string | undefined>(o, 'error'),
  }
}
