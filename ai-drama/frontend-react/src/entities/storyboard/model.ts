/** 分镜（storyboard）领域模型与 DTO mapper（后端 snake_case；关联资产已内嵌） */
import { asArray, asRecord, field } from '@/shared/api/dto'
import { mapCharacter, mapProp, type Character, type Prop } from '@/entities/asset/model'

export interface Storyboard {
  id: number
  episodeId: number
  sceneId: number | null
  storyboardNumber: number
  title: string
  location: string
  time: string
  shotType: string
  angle: string
  movement: string
  result: string
  atmosphere: string
  imagePrompt: string
  videoPrompt: string
  bgmPrompt: string
  soundEffect: string
  description: string
  /** 秒；2–30 由工作台钳制 */
  duration: number
  composedImage: string
  firstFrameImage: string
  lastFrameImage: string
  referenceImages: string
  videoUrl: string
  subtitleUrl: string
  composedVideoUrl: string
  status: string
  characterIds: number[]
  propIds: number[]
  characters: Character[]
  props: Prop[]
  createdAt: string
  updatedAt: string
}

export function mapStoryboard(raw: unknown): Storyboard {
  const o = asRecord(raw)
  return {
    id: Number(field(o, 'id') ?? 0),
    episodeId: Number(field(o, 'episode_id') ?? 0),
    sceneId: (field(o, 'scene_id') as number | null) ?? null,
    storyboardNumber: Number(field(o, 'storyboard_number') ?? 0),
    title: String(field(o, 'title') ?? ''),
    location: String(field(o, 'location') ?? ''),
    time: String(field(o, 'time') ?? ''),
    shotType: String(field(o, 'shot_type') ?? ''),
    angle: String(field(o, 'angle') ?? ''),
    movement: String(field(o, 'movement') ?? ''),
    result: String(field(o, 'result') ?? ''),
    atmosphere: String(field(o, 'atmosphere') ?? ''),
    imagePrompt: String(field(o, 'image_prompt') ?? ''),
    videoPrompt: String(field(o, 'video_prompt') ?? ''),
    bgmPrompt: String(field(o, 'bgm_prompt') ?? ''),
    soundEffect: String(field(o, 'sound_effect') ?? ''),
    description: String(field(o, 'description') ?? ''),
    duration: Number(field(o, 'duration') ?? 0),
    composedImage: String(field(o, 'composed_image') ?? ''),
    firstFrameImage: String(field(o, 'first_frame_image') ?? ''),
    lastFrameImage: String(field(o, 'last_frame_image') ?? ''),
    referenceImages: String(field(o, 'reference_images') ?? ''),
    videoUrl: String(field(o, 'video_url') ?? ''),
    subtitleUrl: String(field(o, 'subtitle_url') ?? ''),
    composedVideoUrl: String(field(o, 'composed_video_url') ?? ''),
    status: String(field(o, 'status') ?? 'pending'),
    characterIds: numberArray(field(o, 'character_ids')),
    propIds: numberArray(field(o, 'prop_ids')),
    characters: asArray(o.characters).map(mapCharacter),
    props: asArray(o.props).map(mapProp),
    createdAt: String(field(o, 'created_at') ?? ''),
    updatedAt: String(field(o, 'updated_at') ?? ''),
  }
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.map((v) => Number(v)).filter((v) => Number.isFinite(v)) : []
}
