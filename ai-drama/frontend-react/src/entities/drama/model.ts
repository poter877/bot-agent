/** 项目（drama）领域模型与 DTO mapper（后端 snake_case） */
import { asArray, asRecord, field, parseJsonArray } from '@/shared/api/dto'
import { mapCharacter, mapProp, mapScene, type Character, type Prop, type Scene } from '@/entities/asset/model'
import { mapEpisode, type Episode } from '@/entities/episode/model'

export type ProjectType = 'drama' | 'creative' | 'film'
export type { CreativeCategory } from '@/entities/creative/model'
import type { CreativeCategory } from '@/entities/creative/model'

export interface Drama {
  id: number
  title: string
  projectType: ProjectType
  filmStyle: string | null
  creativeCategory: CreativeCategory | null
  description: string
  genre: string
  /** 风格预设 value（如 '3d'），展示名经 stylePresets 解析 */
  style: string
  aspectRatio: string
  totalEpisodes: number
  totalDuration: number
  status: string
  thumbnail: string
  tags: string[]
  episodes: Episode[]
  characters: Character[]
  scenes: Scene[]
  props: Prop[]
  createdAt: string
  updatedAt: string
}

/** @param raw 后端 drama DTO（snake_case，episodes/characters/scenes/props 已内嵌） */
export function mapDrama(raw: unknown): Drama {
  const o = asRecord(raw)
  return {
    id: Number(field(o, 'id') ?? 0),
    title: String(field(o, 'title') ?? ''),
    projectType: field(o, 'project_type') === 'creative' ? 'creative' : field(o, 'project_type') === 'film' ? 'film' : 'drama',
    filmStyle: typeof field(o, 'film_style') === 'string' ? field(o, 'film_style') as string : null,
    creativeCategory: typeof field(o, 'creative_category') === 'string' ? field(o, 'creative_category') as string : null,
    description: String(field(o, 'description') ?? ''),
    genre: String(field(o, 'genre') ?? ''),
    style: String(field(o, 'style') ?? '3d'),
    aspectRatio: String(field(o, 'aspect_ratio') ?? '16:9'),
    totalEpisodes: Number(field(o, 'total_episodes') ?? 0),
    totalDuration: Number(field(o, 'total_duration') ?? 0),
    status: String(field(o, 'status') ?? 'draft'),
    thumbnail: String(field(o, 'thumbnail') ?? ''),
    tags: parseJsonArray(field(o, 'tags')),
    episodes: asArray(field(o, 'episodes')).map(mapEpisode),
    characters: asArray(field(o, 'characters')).map(mapCharacter),
    scenes: asArray(field(o, 'scenes')).map(mapScene),
    props: asArray(field(o, 'props')).map(mapProp),
    createdAt: String(field(o, 'created_at') ?? ''),
    updatedAt: String(field(o, 'updated_at') ?? ''),
  }
}

export function projectPath(project: Pick<Drama, 'id' | 'projectType'>): string {
  if (project.projectType === 'creative') return `/creative/${project.id}`
  if (project.projectType === 'film') return `/film/${project.id}`
  return `/drama/${project.id}`
}

export interface DramaListFilters {
  keyword?: string
  status?: string
}
