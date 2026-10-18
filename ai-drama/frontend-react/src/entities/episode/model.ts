/** 集（episode）领域模型与 DTO mapper（后端 snake_case） */
import { asRecord, field } from '@/shared/api/dto'

export interface Episode {
  id: number
  dramaId: number
  episodeNumber: number
  title: string
  content: string
  scriptContent: string
  description: string
  duration: number
  status: string
  videoUrl: string
  thumbnail: string
  imageConfigId: number | null
  videoConfigId: number | null
  /** '480p' | '720p' | '1080p' */
  resolution: string
  createdAt: string
  updatedAt: string
}

export function mapEpisode(raw: unknown): Episode {
  const o = asRecord(raw)
  return {
    id: Number(field(o, 'id') ?? 0),
    dramaId: Number(field(o, 'drama_id') ?? 0),
    episodeNumber: Number(field(o, 'episode_number') ?? 0),
    title: String(field(o, 'title') ?? ''),
    content: String(field(o, 'content') ?? ''),
    scriptContent: String(field(o, 'script_content') ?? ''),
    description: String(field(o, 'description') ?? ''),
    duration: Number(field(o, 'duration') ?? 0),
    status: String(field(o, 'status') ?? 'draft'),
    videoUrl: String(field(o, 'video_url') ?? ''),
    thumbnail: String(field(o, 'thumbnail') ?? ''),
    imageConfigId: (field(o, 'image_config_id') as number | null) ?? null,
    videoConfigId: (field(o, 'video_config_id') as number | null) ?? null,
    resolution: String(field(o, 'resolution') ?? '720p'),
    createdAt: String(field(o, 'created_at') ?? ''),
    updatedAt: String(field(o, 'updated_at') ?? ''),
  }
}
