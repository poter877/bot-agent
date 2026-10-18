import { parsePipelineAutomation } from '@/entities/creative/automation'
import type { CreativeDraft, CreativeProject, CreativeShot } from '@/entities/creative/model'

export function validateCreativeDraft(draft: CreativeDraft): boolean {
  return !parsePipelineAutomation(draft.production?.fields.automation).error && !!draft.title.trim()
    && Number.isFinite(draft.brief.targetDuration) && draft.brief.targetDuration >= 5 && draft.brief.targetDuration <= 3600
    && Number.isFinite(draft.audio.musicVolume) && draft.audio.musicVolume >= 0 && draft.audio.musicVolume <= 1
    && draft.shots.length <= 200
    && draft.shots.reduce((total, shot) => total + shot.duration, 0) <= 3600
    && draft.shots.every((shot) => Number.isFinite(shot.duration) && shot.duration >= 1 / 30 && shot.duration <= 600
      && Number.isFinite(shot.trimStart) && shot.trimStart >= 0
      && Number.isFinite(shot.audioTrimStart ?? 0) && (shot.audioTrimStart ?? 0) >= 0
      && Number.isFinite(shot.originalVolume) && shot.originalVolume >= 0 && shot.originalVolume <= 1)
}

export function moveCreativeShot(shots: CreativeShot[], id: string, delta: -1 | 1): CreativeShot[] {
  const index = shots.findIndex((shot) => shot.id === id)
  if (index < 0 || index + delta < 0 || index + delta >= shots.length) return shots
  const result = [...shots]
  ;[result[index], result[index + delta]] = [result[index + delta], result[index]]
  return result
}

export function shotHasMedia(shot: CreativeShot): boolean {
  return !!(shot.mediaType === 'video' ? shot.videoUrl : shot.imageUrl)
}

/** Generated media is server-owned unless the draft explicitly replaces it (e.g. an upload). */
export function mergeCreativeMedia(draft: CreativeDraft, baseline: CreativeDraft, latest: CreativeProject): CreativeDraft {
  return {
    ...draft,
    shots: draft.shots.map((shot) => {
      const old = baseline.shots.find((item) => item.id === shot.id)
      const current = latest.shots.find((item) => item.id === shot.id)
      if (!old || !current) return shot
      return {
        ...shot,
        ...(shot.imageUrl === old.imageUrl && shot.imageTaskId === old.imageTaskId
          ? { imageUrl: current.imageUrl, imageTaskId: current.imageTaskId } : {}),
        ...(shot.videoUrl === old.videoUrl && shot.videoTaskId === old.videoTaskId
          ? { videoUrl: current.videoUrl, videoTaskId: current.videoTaskId } : {}),
      }
    }),
  }
}
