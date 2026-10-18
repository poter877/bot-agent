/** 资产领域模型（角色/场景/道具）与 DTO mapper（后端 snake_case；scenes 创建接口返回 camelCase） */
import { asRecord, field } from '@/shared/api/dto'

export interface Character {
  id: number
  dramaId: number
  name: string
  role: string
  description: string
  appearance: string
  styling: string
  finalPrompt: string
  personality: string
  imageUrl: string
  referenceImages: string
  seedValue: number | null
  sortOrder: number
  localPath: string
  createdAt: string
  updatedAt: string
}

export function mapCharacter(raw: unknown): Character {
  const o = asRecord(raw)
  return {
    id: Number(field(o, 'id') ?? 0),
    dramaId: Number(field(o, 'drama_id') ?? 0),
    name: String(field(o, 'name') ?? ''),
    role: String(field(o, 'role') ?? ''),
    description: String(field(o, 'description') ?? ''),
    appearance: String(field(o, 'appearance') ?? ''),
    styling: String(field(o, 'styling') ?? ''),
    finalPrompt: String(field(o, 'final_prompt') ?? ''),
    personality: String(field(o, 'personality') ?? ''),
    imageUrl: String(field(o, 'image_url') ?? ''),
    referenceImages: String(field(o, 'reference_images') ?? ''),
    seedValue: (field(o, 'seed_value') as number | null) ?? null,
    sortOrder: Number(field(o, 'sort_order') ?? 0),
    localPath: String(field(o, 'local_path') ?? ''),
    createdAt: String(field(o, 'created_at') ?? ''),
    updatedAt: String(field(o, 'updated_at') ?? ''),
  }
}

export interface Scene {
  id: number
  dramaId: number
  episodeId: number | null
  location: string
  time: string
  prompt: string
  lighting: string
  finalPrompt: string
  storyboardCount: number
  imageUrl: string
  status: string
  localPath: string
  createdAt: string
  updatedAt: string
}

export function mapScene(raw: unknown): Scene {
  const o = asRecord(raw)
  return {
    id: Number(field(o, 'id') ?? 0),
    dramaId: Number(field(o, 'drama_id') ?? 0),
    episodeId: (field(o, 'episode_id') as number | null) ?? null,
    location: String(field(o, 'location') ?? ''),
    time: String(field(o, 'time') ?? ''),
    prompt: String(field(o, 'prompt') ?? ''),
    lighting: String(field(o, 'lighting') ?? ''),
    finalPrompt: String(field(o, 'final_prompt') ?? ''),
    storyboardCount: Number(field(o, 'storyboard_count') ?? 0),
    imageUrl: String(field(o, 'image_url') ?? ''),
    status: String(field(o, 'status') ?? 'pending'),
    localPath: String(field(o, 'local_path') ?? ''),
    createdAt: String(field(o, 'created_at') ?? ''),
    updatedAt: String(field(o, 'updated_at') ?? ''),
  }
}

export interface Prop {
  id: number
  dramaId: number
  name: string
  type: string
  description: string
  prompt: string
  finalPrompt: string
  imageUrl: string
  referenceImages: string
  localPath: string
  createdAt: string
  updatedAt: string
}

export function mapProp(raw: unknown): Prop {
  const o = asRecord(raw)
  return {
    id: Number(field(o, 'id') ?? 0),
    dramaId: Number(field(o, 'drama_id') ?? 0),
    name: String(field(o, 'name') ?? ''),
    type: String(field(o, 'type') ?? ''),
    description: String(field(o, 'description') ?? ''),
    prompt: String(field(o, 'prompt') ?? ''),
    finalPrompt: String(field(o, 'final_prompt') ?? ''),
    imageUrl: String(field(o, 'image_url') ?? ''),
    referenceImages: String(field(o, 'reference_images') ?? ''),
    localPath: String(field(o, 'local_path') ?? ''),
    createdAt: String(field(o, 'created_at') ?? ''),
    updatedAt: String(field(o, 'updated_at') ?? ''),
  }
}

export type AssetKind = 'character' | 'scene' | 'prop'
