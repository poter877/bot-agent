import type { CreativeRecipe } from './catalog'
export type CreativeCategory = string

export interface CreativeTask {
  id: number
  status: string
  errorMsg: string | null
  localPath: string | null
}

export interface CreativeShot {
  id: string
  title: string
  duration: number
  visualPrompt: string
  narration: string
  caption: string
  mediaType: 'image' | 'video'
  toolPlan?: { toolId: string; args: Record<string, unknown>; reason?: string }
  imageUrl: string | null
  videoUrl: string | null
  imageTaskId: number | null
  videoTaskId: number | null
  audioUrl?: string | null
  audioTrimStart?: number
  trimStart: number
  originalVolume: number
  imageTask?: CreativeTask
  videoTask?: CreativeTask
}

export interface CreativeRender {
  id: number
  status: string
  progress: number
  videoUrl: string | null
  subtitleUrl: string | null
  duration: number | null
  errorMsg: string | null
  warnings: string[]
  createdAt: string
  revision: number
  outputs?: { shotId: string; title: string; videoUrl: string; subtitleUrl: string | null; duration: number }[]
}

export interface CreativeSource {
  id: string; name: string; kind: 'image' | 'video' | 'audio'; url: string; duration: number | null
  coverUrl: string | null; transcript: string; attribution: string
}
export interface CreativeProduction { fields: Record<string, string>; sources: CreativeSource[] }
export interface CreativeProject {
  id: number
  title: string
  category: CreativeCategory
  recipe?: CreativeRecipe
  style: string
  aspectRatio: '16:9' | '9:16' | '1:1'
  revision: number
  approvedRevision: number | null
  production?: CreativeProduction
  brief: { idea: string; audience: string; tone: string; targetDuration: number; language: string }
  plan: { summary: string; script: string; musicDirection: string }
  shots: CreativeShot[]
  audio: { narrationUrl: string | null; musicUrl: string | null; musicVolume: number; burnSubtitles: boolean }
  renders: CreativeRender[]
  updatedAt: string
}

export type CreativeDraft = Pick<CreativeProject, 'revision' | 'title' | 'brief' | 'plan' | 'shots' | 'audio' | 'production'>

export function toCreativeDraft(project: CreativeProject): CreativeDraft {
  return {
    revision: project.revision,
    title: project.title,
    brief: { ...project.brief },
    plan: { ...project.plan },
    shots: project.shots.map(({ imageTask: _imageTask, videoTask: _videoTask, ...shot }) => ({ ...shot })),
    audio: { ...project.audio },
    production: { fields: { ...project.production?.fields }, sources: project.production?.sources.map(source => ({...source})) ?? [] },
  }
}

export function taskIsActive(status?: string): boolean {
  return status === 'pending' || status === 'queued' || status === 'processing' || status === 'running'
}

export function hasActiveShotTasks(project: CreativeProject): boolean {
  return project.shots.some((shot) => taskIsActive(shot.imageTask?.status) || taskIsActive(shot.videoTask?.status))
}

export function hasCreativeActivity(project: CreativeProject): boolean {
  return hasActiveShotTasks(project) || project.renders.some((render) => taskIsActive(render.status))
}

export function newCreativeShot(title: string): CreativeShot {
  return {
    id: crypto.randomUUID(), title, duration: 5, visualPrompt: '', narration: '', caption: '',
    mediaType: 'image', imageUrl: null, videoUrl: null, imageTaskId: null, videoTaskId: null,
    trimStart: 0, originalVolume: 1,
  }
}

export function creativeMediaUrl(path?: string | null): string {
  if (!path) return ''
  return path.startsWith('static/') ? `/${path}` : path
}
