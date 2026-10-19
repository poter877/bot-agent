import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

import { creativeCategoryIds, getCreativeRecipe, type CreativeCategory } from './creative-catalog.js'
export type { CreativeCategory } from './creative-catalog.js'
export const creativeCategories = creativeCategoryIds
export const creativeCategorySchema = z.enum(creativeCategories)
export const aspectRatioSchema = z.enum(['16:9', '9:16', '1:1'])
export const revisionSchema = z.number().int().positive()
const text = (max: number) => z.string().max(max)
export const mediaUrl = z
  .string()
  .max(1024)
  .refine((value) => {
    // This workflow only uses files in the app media store, never arbitrary network/file URLs.
    return (
      /^\/?static\/[a-zA-Z0-9_/-]+\.[a-zA-Z0-9]+$/.test(value) &&
      !value.includes('..') &&
      !value.includes('//')
    )
  }, '请使用已上传或已生成的本地素材')
  .transform((value) => (value.startsWith('/') ? value : `/${value}`))
  .nullable()

export const creativeBriefSchema = z.object({
  idea: text(20000),
  audience: text(1000),
  tone: text(1000),
  targetDuration: z.number().finite().min(5).max(3600),
  language: z.string().trim().min(1).max(64),
})
export const creativePlanSchema = z.object({
  summary: text(10000),
  script: text(30000),
  musicDirection: text(4000),
})
const shotToolSchema = z
  .object({
    toolId: z
      .string()
      .regex(/^[a-z0-9_]+$/)
      .max(100),
    args: z
      .record(z.string().max(80), z.unknown())
      .refine((value) => JSON.stringify(value).length <= 20000, '镜头工具参数过大'),
    reason: text(1000).optional(),
  })
  .strict()
export const shotToolPlanSchema = shotToolSchema.extend({ chain: z.array(shotToolSchema).max(12).optional() })
export const creativeShotSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9_-]+$/),
  title: text(200),
  duration: z
    .number()
    .finite()
    .min(1 / 30)
    .max(600),
  visualPrompt: text(6000),
  narration: text(3000),
  caption: text(3000),
  mediaType: z.enum(['image', 'video']),
  imageUrl: mediaUrl,
  videoUrl: mediaUrl,
  imageTaskId: z.number().int().positive().nullable().default(null),
  videoTaskId: z.number().int().positive().nullable().default(null),
  audioUrl: mediaUrl.default(null),
  audioTrimStart: z.number().finite().min(0).max(86400).default(0),
  trimStart: z.number().finite().min(0).max(86400),
  originalVolume: z.number().finite().min(0).max(2),
  toolPlan: shotToolPlanSchema.optional(),
})
export const creativeAudioSchema = z.object({
  narrationUrl: mediaUrl,
  musicUrl: mediaUrl,
  musicVolume: z.number().finite().min(0).max(2),
  burnSubtitles: z.boolean(),
})
export const creativeSourceSchema = z.object({
  id: z.string().uuid(),
  name: text(200),
  kind: z.enum(['image', 'video', 'audio']),
  url: mediaUrl.refine((v) => !!v),
  duration: z.number().finite().min(0).max(86400).nullable(),
  coverUrl: mediaUrl.default(null),
  transcript: text(60000).default(''),
  attribution: text(2000).default(''),
})
export const creativeProductionSchema = z
  .object({
    fields: z
      .record(z.string().max(80), text(20000))
      .refine((v) => Object.keys(v).length <= 24)
      .default({}),
    sources: z
      .array(creativeSourceSchema)
      .max(50)
      .refine(
        (sources) => new Set(sources.map((source) => source.id)).size === sources.length,
        '素材 ID 不能重复',
      )
      .default([]),
  })
  .default({ fields: {}, sources: [] })
export const creativeDocumentSchema = z.object({
  brief: creativeBriefSchema,
  plan: creativePlanSchema,
  production: creativeProductionSchema,
  shots: z
    .array(creativeShotSchema)
    .max(200)
    .refine((shots) => new Set(shots.map((s) => s.id)).size === shots.length, '镜头 ID 不能重复')
    .refine(
      (shots) => shots.reduce((total, shot) => total + shot.duration, 0) <= 3600,
      '视频总时长不能超过 3600 秒',
    ),
  audio: creativeAudioSchema,
})
export const creativeSaveSchema = creativeDocumentSchema.extend({
  revision: revisionSchema,
  title: z.string().trim().min(1).max(200).optional(),
})
export type CreativeShot = z.input<typeof creativeShotSchema>
export type CreativeDocument = z.infer<typeof creativeDocumentSchema>

export function createCreativeDocument(category: CreativeCategory = 'explainer'): CreativeDocument {
  return {
    brief: {
      idea: '',
      audience: '',
      tone: '',
      targetDuration: getCreativeRecipe(category).duration,
      language: 'zh-CN',
    },
    production: { fields: {}, sources: [] },
    plan: { summary: '', script: '', musicDirection: '' },
    shots: [],
    audio: { narrationUrl: null, musicUrl: null, musicVolume: 0.2, burnSubtitles: false },
  }
}

export function shotFingerprint(shot: CreativeShot, style: string, aspectRatio: string) {
  return createHash('sha256')
    .update(JSON.stringify({ prompt: shot.visualPrompt, duration: shot.duration, style, aspectRatio }))
    .digest('hex')
}

export const generatedPlanSchema = z.object({
  summary: text(10000),
  script: text(30000),
  musicDirection: text(4000),
  shots: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        duration: z
          .number()
          .finite()
          .min(1 / 30)
          .max(600),
        sourceId: z.string().uuid().optional(),
        trimStart: z.number().finite().min(0).max(86400).optional(),
        visualPrompt: z.string().min(1).max(6000),
        narration: text(3000),
        caption: text(3000),
        mediaType: z.enum(['image', 'video']),
        toolPlan: shotToolPlanSchema.optional(),
      }),
    )
    .min(1)
    .max(200),
})

export function parseGeneratedPlan(raw: string, document: CreativeDocument): CreativeDocument {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  let json: unknown
  try {
    json = JSON.parse(trimmed)
  } catch {
    throw new Error('模型未返回有效制作方案，请重试或手动编写')
  }
  const parsed = generatedPlanSchema.safeParse(json)
  if (!parsed.success) throw new Error('模型返回的镜头字段或时长不符合要求，请重试或手动编写')
  const total = parsed.data.shots.reduce((sum, shot) => sum + shot.duration, 0)
  if (Math.abs(total - document.brief.targetDuration) > Math.max(2, document.brief.targetDuration * 0.15)) {
    throw new Error('模型方案的镜头总时长与目标相差过大，请重试或手动编写')
  }
  return creativeDocumentSchema.parse({
    ...document,
    plan: {
      summary: parsed.data.summary,
      script: parsed.data.script,
      musicDirection: parsed.data.musicDirection,
    },
    shots: parsed.data.shots.map((shot) => {
      const source = shot.sourceId
        ? document.production.sources.find((item) => item.id === shot.sourceId)
        : undefined
      if (shot.sourceId && !source) throw new Error('模型返回的原片素材不存在')
      const start = shot.trimStart ?? 0
      if (!source && shot.duration > 15) throw new Error('模型返回的生成镜头不能超过15秒，请拆分镜头')
      if (source?.duration != null && start + shot.duration > source.duration + 1 / 30)
        throw new Error('模型返回的源片时间超出素材时长')
      return {
        title: shot.title,
        duration: shot.duration,
        visualPrompt: shot.visualPrompt,
        narration: shot.narration,
        caption: shot.caption,
        mediaType: source ? (source.kind === 'video' ? 'video' : 'image') : shot.mediaType,
        id: randomUUID(),
        imageUrl: source?.kind === 'image' ? source.url : (source?.coverUrl ?? null),
        videoUrl: source?.kind === 'video' ? source.url : null,
        imageTaskId: null,
        videoTaskId: null,
        audioUrl: source?.kind === 'audio' ? source.url : null,
        audioTrimStart: start,
        trimStart: start,
        originalVolume: 1,
        ...(shot.toolPlan ? { toolPlan: shot.toolPlan } : {}),
      }
    }),
  })
}

export class CreativeError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409 | 422 | 503 = 400,
  ) {
    super(message)
  }
}
