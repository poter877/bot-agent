import fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema, getInsertId } from '../../db/index.js'
import { CreativeError } from '../creative-model.js'
import {
  approveCreativeProject,
  getCreativeProject,
  requireCreativeRevision,
  saveCreativeProject,
  validateCreativeMedia,
  withCreativeMutation,
} from '../creative-projects.js'
import { inspectCreativeSource } from '../creative-renderer.js'
import { requireToolConfig } from './settings.js'
import { ProviderRejected, checkRemoteUrl, providerJson, remoteBytes } from './network.js'
import { inspectGlb, readModelFile, mediaPath, trimToolMedia, writeToolFile } from './files.js'

export const toolKindSchema = z.enum(['lipsync', 'rigging', 'research', 'stock'])
export type ToolKind = z.infer<typeof toolKindSchema>
const providerFor = { lipsync: 'sync', rigging: 'meshy', research: 'tavily', stock: 'pexels' } as const
const idSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/)
export const toolInputSchema = z
  .object({
    shotId: z.string().max(80).optional(),
    modelId: z.number().int().positive().optional(),
    height: z.number().min(0.1).max(10).default(1.7),
    query: z.string().trim().max(500).optional(),
    media: z.enum(['video', 'image']).default('video'),
  })
  .strict()
export const toolDependencies = { json: providerJson, bytes: remoteBytes, inspect: inspectCreativeSource }
export type ToolDependencies = typeof toolDependencies
type Row = typeof schema.creativeToolJobs.$inferSelect
type Input = {
  configId?: number
  shotId?: string
  shotMediaType?: 'image' | 'video'
  videoUrl?: string
  imageUrl?: string
  audioUrl?: string
  trimStart?: number
  audioTrimStart?: number
  duration?: number
  modelUrl?: string
  modelId?: number
  height?: number
  query?: string
  media?: 'image' | 'video'
  model?: string
  orientation?: string
}
export type ToolFile = {
  name: string
  url: string
  kind: 'video' | 'model'
  metadata?: { meshes: number; joints: number; animations: number }
}
export type StockCandidate = {
  id: string
  kind: 'image' | 'video'
  title: string
  url: string
  preview: string
  pageUrl: string
  author: string
  authorUrl: string
  duration: number | null
  licenseUrl: string
}
export type ResearchArticle = { title: string; url: string; content: string }
type Result = {
  files?: ToolFile[]
  articles?: ResearchArticle[]
  candidates?: StockCandidate[]
  imports?: Record<string, string>
  uploads?: Record<string, string>
  submissionStarted?: boolean
  pollUntil?: number
  appliedRevision?: number
}
const ts = () => new Date().toISOString()
function result(row: Row): Result {
  return JSON.parse(row.result)
}
function input(row: Row): Input {
  return JSON.parse(row.input)
}
function rowFor(projectId: number, id: number) {
  getCreativeProject(projectId)
  const row = db
    .select()
    .from(schema.creativeToolJobs)
    .where(and(eq(schema.creativeToolJobs.id, id), eq(schema.creativeToolJobs.projectId, projectId)))
    .get()
  if (!row) throw new CreativeError('制作任务不存在', 404)
  return row
}
function update(row: Row, patch: Partial<Row>) {
  db.update(schema.creativeToolJobs)
    .set({ ...patch, updatedAt: ts() })
    .where(eq(schema.creativeToolJobs.id, row.id))
    .run()
}
export function publicToolJob(row: Row) {
  const { input: raw, result: rawResult, fingerprint, ...rest } = row
  const { uploads, submissionStarted, pollUntil, ...output } = JSON.parse(rawResult) as Result
  return { ...rest, input: JSON.parse(raw) as Input, result: output }
}
export function listToolJobs(projectId: number) {
  getCreativeProject(projectId)
  return db
    .select()
    .from(schema.creativeToolJobs)
    .where(eq(schema.creativeToolJobs.projectId, projectId))
    .orderBy(desc(schema.creativeToolJobs.id))
    .limit(100)
    .all()
    .map(publicToolJob)
}
export function appliedLipSyncJobs(projectId: number) {
  getCreativeProject(projectId)
  return db
    .select()
    .from(schema.creativeToolJobs)
    .where(
      and(
        eq(schema.creativeToolJobs.projectId, projectId),
        eq(schema.creativeToolJobs.kind, 'lipsync'),
        eq(schema.creativeToolJobs.status, 'completed'),
      ),
    )
    .all()
    .map(publicToolJob)
}
export function getToolJob(projectId: number, id: number) {
  return publicToolJob(rowFor(projectId, id))
}
export function listCreativeModels(projectId: number) {
  getCreativeProject(projectId)
  return db
    .select()
    .from(schema.creativeModels)
    .where(eq(schema.creativeModels.projectId, projectId))
    .all()
    .map((row) => ({ ...row, metadata: JSON.parse(row.metadata) }))
}
export async function uploadCreativeModel(projectId: number, name: string, bytes: Buffer) {
  getCreativeProject(projectId)
  if (listCreativeModels(projectId).length >= 50) throw new CreativeError('项目模型最多50个')
  if (bytes.length > 50 * 1024 * 1024) throw new CreativeError('模型不能超过50MB')
  const metadata = inspectGlb(bytes)
  const url = await writeToolFile(projectId, bytes, 'glb')
  const id = getInsertId(
    db
      .insert(schema.creativeModels)
      .values({
        projectId,
        name: name.slice(0, 200),
        url,
        metadata: JSON.stringify(metadata),
        createdAt: ts(),
      })
      .run(),
  )
  return { id, projectId, name, url, metadata }
}

export function createToolService(deps: ToolDependencies = toolDependencies, pollMs = 10000) {
  const workers = new Map<number, Promise<void>>(),
    timers = new Map<number, ReturnType<typeof setTimeout>>()
  const clear = (id: number) => {
    const timer = timers.get(id)
    if (timer) clearTimeout(timer)
    timers.delete(id)
  }
  const current = (row: Row) => rowFor(row.projectId, row.id)
  const saveResult = (row: Row, patch: Partial<Result>) => {
    const fresh = current(row)
    update(fresh, { result: JSON.stringify({ ...result(fresh), ...patch }) })
  }
  async function uploadSync(row: Row, file: string, kind: 'video' | 'audio' | 'image', key: string) {
    const cached = result(current(row)).uploads?.[kind]
    if (cached) return cached
    const bytes = await fs.readFile(file)
    if (bytes.length > 256 * 1024 * 1024) throw new CreativeError('口型输入单文件不能超过256MB', 422)
    const contentType = kind === 'video' ? 'video/mp4' : kind === 'image' ? 'image/png' : 'audio/wav'
    const upload = z.object({ uploadUrl: z.string().url(), url: z.string().url() }).parse(
      await deps.json('https://api.sync.so/v2/assets/upload', key, {
        fileName: kind === 'image' ? 'portrait.png' : kind === 'video' ? 'clip.mp4' : 'voice.wav',
        contentType,
        size: bytes.length,
      }),
    )
    await deps.bytes(upload.uploadUrl, ['sync.so', 'amazonaws.com', 'storage.googleapis.com'], 1024 * 1024, {
      method: 'PUT',
      body: bytes,
      contentType,
    })
    const asset = z.object({ id: idSchema }).parse(
      await deps.json('https://api.sync.so/v2/assets', key, {
        url: upload.url,
        type: kind.toUpperCase(),
        name: `video-factory-${row.id}`,
      }),
    )
    saveResult(row, { uploads: { ...result(current(row)).uploads, [kind]: asset.id } })
    return asset.id
  }
  async function execute(row: Row) {
    const data = input(row),
      kind = row.kind as ToolKind,
      config = requireToolConfig(providerFor[kind], data.configId),
      key = config.apiKey
    if (!row.remoteId) {
      update(row, { status: 'submitting', error: null })
      if (kind === 'lipsync') {
        const temps: string[] = []
        try {
          let visualId: string
          if (data.videoUrl) {
            validateCreativeMedia(row.projectId, data.videoUrl, 'video')
            const f = await trimToolMedia(row.projectId, data.videoUrl, data.trimStart!, data.duration!)
            temps.push(f)
            visualId = await uploadSync(row, f, 'video', key)
          } else {
            validateCreativeMedia(row.projectId, data.imageUrl!, 'image')
            const sharp = (await import('sharp')).default
            const png = await sharp(mediaPath(data.imageUrl!)).png().toBuffer()
            const url = await writeToolFile(row.projectId, png, 'png')
            temps.push(mediaPath(url))
            visualId = await uploadSync(row, mediaPath(url), 'image', key)
          }
          validateCreativeMedia(row.projectId, data.audioUrl!, 'audio')
          const audio = await trimToolMedia(
            row.projectId,
            data.audioUrl!,
            data.audioTrimStart!,
            data.duration!,
            true,
          )
          temps.push(audio)
          const audioId = await uploadSync(row, audio, 'audio', key)
          saveResult(row, { submissionStarted: true })
          const generated = z.object({ id: idSchema }).parse(
            await deps.json(
              'https://api.sync.so/v2/generate',
              key,
              {
                model: data.model,
                input: [
                  { type: data.videoUrl ? 'video' : 'image', assetId: visualId },
                  { type: 'audio', assetId: audioId },
                ],
                options: { sync_mode: 'cut_off' },
              },
              { 'Idempotency-Key': `video-factory-${row.id}-${row.fingerprint.slice(0, 24)}` },
            ),
          )
          update(row, { remoteId: generated.id, status: 'running' })
        } finally {
          await Promise.allSettled(temps.map((file) => fs.rm(file, { force: true })))
        }
      } else if (kind === 'rigging') {
        const bytes = await readModelFile(row.projectId, data.modelUrl!)
        inspectGlb(bytes)
        saveResult(row, { submissionStarted: true })
        const generated = z.object({ result: idSchema }).parse(
          await deps.json('https://api.meshy.ai/openapi/v1/rigging', key, {
            model_url: `data:application/octet-stream;base64,${bytes.toString('base64')}`,
            height_meters: data.height,
          }),
        )
        update(row, { remoteId: generated.result, status: 'running' })
      } else if (kind === 'research') {
        const response = z
          .object({
            results: z
              .array(z.object({ title: z.string(), url: z.string().url(), content: z.string() }))
              .max(20),
          })
          .parse(
            await deps.json('https://api.tavily.com/search', key, {
              query: data.query,
              search_depth: 'basic',
              max_results: 6,
              include_answer: false,
              include_raw_content: false,
            }),
          )
        const articles = response.results
          .filter((r) => /^https?:\/\//.test(r.url))
          .map((r) => ({ ...r, title: r.title.slice(0, 500), content: r.content.slice(0, 10000) }))
        update(row, { status: 'completed', progress: 100, result: JSON.stringify({ articles }) })
        return
      } else {
        const endpoint = data.media === 'image' ? 'search' : 'videos/search'
        const params = new URLSearchParams({
          query: data.query!,
          per_page: '12',
          orientation: data.orientation!,
        })
        const response = await deps.json(`https://api.pexels.com/v1/${endpoint}?${params}`, key)
        const candidates: StockCandidate[] =
          data.media === 'image'
            ? z
                .array(
                  z.object({
                    id: z.number(),
                    alt: z.string().optional(),
                    url: z.string().url(),
                    photographer: z.string(),
                    photographer_url: z.string().url(),
                    src: z.object({ large2x: z.string().url(), medium: z.string().url() }),
                  }),
                )
                .max(80)
                .parse(response.photos)
                .map((p) => ({
                  id: String(p.id),
                  kind: 'image',
                  title: p.alt || `Pexels ${p.id}`,
                  url: p.src.large2x,
                  preview: p.src.medium,
                  pageUrl: p.url,
                  author: p.photographer,
                  authorUrl: p.photographer_url,
                  duration: null,
                  licenseUrl: 'https://www.pexels.com/license/',
                }))
            : z
                .array(
                  z.object({
                    id: z.number(),
                    url: z.string().url(),
                    image: z.string().url(),
                    duration: z.number().positive(),
                    user: z.object({ name: z.string(), url: z.string().url() }),
                    video_files: z.array(
                      z.object({
                        link: z.string().url(),
                        file_type: z.string(),
                        width: z.number().nullable(),
                        height: z.number().nullable(),
                      }),
                    ),
                  }),
                )
                .max(80)
                .parse(response.videos)
                .flatMap((v) => {
                  const options = v.video_files
                    .filter((f) => f.file_type === 'video/mp4' && f.width && f.height)
                    .sort((a, b) => Math.abs(a.height! - 1080) - Math.abs(b.height! - 1080))
                  const file = options[0]
                  return file
                    ? [
                        {
                          id: String(v.id),
                          kind: 'video' as const,
                          title: `Pexels ${v.id}`,
                          url: file.link,
                          preview: v.image,
                          pageUrl: v.url,
                          author: v.user.name,
                          authorUrl: v.user.url,
                          duration: v.duration,
                          licenseUrl: 'https://www.pexels.com/license/',
                        },
                      ]
                    : []
                })
        for (const c of candidates)
          for (const url of [c.url, c.preview, c.pageUrl, c.authorUrl]) checkRemoteUrl(url, ['pexels.com'])
        update(row, { status: 'completed', progress: 100, result: JSON.stringify({ candidates }) })
        return
      }
      row = current(row)
    }
    if (Date.now() > (result(row).pollUntil ?? Date.parse(row.createdAt) + 6 * 60 * 60 * 1000))
      throw new CreativeError('任务查询已超过6小时，已暂停自动查询；可在制作工具中恢复', 503)
    if (kind === 'lipsync') {
      const response = z
        .object({
          status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REJECTED']),
          outputUrl: z.string().nullable().optional(),
        })
        .parse(await deps.json(`https://api.sync.so/v2/generate/${encodeURIComponent(row.remoteId!)}`, key))
      if (['FAILED', 'REJECTED'].includes(response.status))
        throw new CreativeError('口型服务未能完成此任务，请检查人脸可见性和配音后重新提交', 422)
      if (response.status !== 'COMPLETED') {
        update(row, { status: 'running', progress: 0 })
        return
      }
      if (!response.outputUrl) throw new CreativeError('口型服务完成但没有输出地址', 422)
      const bytes = await deps.bytes(
        response.outputUrl,
        ['sync.so', 'amazonaws.com', 'storage.googleapis.com'],
        512 * 1024 * 1024,
      )
      const url = await writeToolFile(row.projectId, bytes, 'mp4')
      try {
        const media = await deps.inspect(row.projectId, url, false)
        if (media.kind !== 'video' || !media.duration || Math.abs(media.duration - data.duration!) > 1 / 30)
          throw new CreativeError('口型成片时长与镜头不一致，请核对输入', 422)
      } catch (error) {
        await fs.rm(mediaPath(url), { force: true })
        throw error
      }
      saveResult(row, { files: [{ name: '口型同步成片', url, kind: 'video' }] })
    } else {
      const response = z
        .object({
          status: z.enum(['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'CANCELED']),
          progress: z.number().optional(),
          result: z
            .object({
              rigged_character_glb_url: z.string().url().optional(),
              rigged_character_fbx_url: z.string().url().optional(),
              basic_animations: z.record(z.string(), z.string()).optional(),
            })
            .nullable()
            .optional(),
        })
        .parse(
          await deps.json(
            `https://api.meshy.ai/openapi/v1/rigging/${encodeURIComponent(row.remoteId!)}`,
            key,
          ),
        )
      if (['FAILED', 'CANCELED'].includes(response.status))
        throw new CreativeError('骨骼绑定失败，请检查模型是否为正向、有纹理且四肢清晰的人形角色', 422)
      if (response.status !== 'SUCCEEDED') {
        update(row, { status: 'running', progress: Math.max(0, Math.min(99, response.progress ?? 0)) })
        return
      }
      if (!response.result?.rigged_character_glb_url)
        throw new CreativeError('绑定任务没有返回 GLB 模型', 422)
      const files = result(row).files ?? []
      const downloads: [string, string | undefined, string][] = [
        ['绑定模型 GLB', response.result.rigged_character_glb_url, 'glb'],
        ['绑定模型 FBX', response.result.rigged_character_fbx_url, 'fbx'],
        ['行走动画', response.result.basic_animations?.walking_glb_url, 'glb'],
        ['跑步动画', response.result.basic_animations?.running_glb_url, 'glb'],
      ]
      for (const [name, remote, ext] of downloads) {
        if (!remote || files.some((f) => f.name === name)) continue
        const bytes = await deps.bytes(remote, ['meshy.ai', 'amazonaws.com'], 100 * 1024 * 1024)
        const metadata = ext === 'glb' ? inspectGlb(bytes, true) : undefined
        if (
          ext === 'fbx' &&
          (bytes.length < 24 ||
            (!bytes.toString('ascii', 0, 23).startsWith('Kaydara FBX Binary') &&
              !bytes.toString('ascii', 0, 200).includes('FBX')))
        )
          throw new CreativeError('返回的 FBX 文件无效', 422)
        const url = await writeToolFile(row.projectId, bytes, ext)
        files.push({ name, url, kind: 'model', metadata })
        saveResult(row, { files })
      }
    }
    update(current(row), { status: 'completed', progress: 100, error: null })
  }
  function launch(row: Row) {
    if (workers.has(row.id)) return
    clear(row.id)
    const promise = (async () => {
      try {
        if (Date.now() - Date.parse(row.createdAt) > 24 * 60 * 60 * 1000 && !row.remoteId)
          throw new CreativeError('未提交任务已过期，请重新创建', 422)
        await execute(row)
        const fresh = current(row)
        if (fresh.status === 'running') {
          const timer = setTimeout(() => {
            timers.delete(row.id)
            try {
              const next = current(row)
              if (next.status === 'running') launch(next)
            } catch {
              /* deleted project */
            }
          }, pollMs)
          timer.unref?.()
          timers.set(row.id, timer)
        }
      } catch (error) {
        try {
          const fresh = current(row)
          const uncertain =
            !fresh.remoteId && result(fresh).submissionStarted && !(error instanceof ProviderRejected)
          update(fresh, {
            status: uncertain ? 'uncertain' : 'failed',
            error:
              error instanceof CreativeError ? error.message : '制作服务返回异常，请检查配置或恢复任务查询',
            ...(error instanceof ProviderRejected
              ? { result: JSON.stringify({ ...result(fresh), submissionStarted: false }) }
              : {}),
          })
        } catch {
          /* deleted project */
        }
      }
    })()
    workers.set(row.id, promise)
    void promise.finally(() => workers.delete(row.id))
  }
  return {
    async start(projectId: number, revision: number, kind: ToolKind, raw: unknown, force = false, configId?: number) {
      const project = requireCreativeRevision(projectId, revision),
        request = toolInputSchema.parse(raw),
        config = requireToolConfig(providerFor[kind], configId)
      let data: Input
      if (kind === 'lipsync') {
        const shot = project.shots.find((s) => s.id === request.shotId)
        const videoUrl = shot?.mediaType === 'video' ? shot.videoUrl : null
        if (!shot || (!videoUrl && !shot.imageUrl) || !shot.audioUrl)
          throw new CreativeError('口型同步需要镜头画面和该镜头的配音，请先保存素材')
        if (!videoUrl && config.model !== 'sync-3')
          throw new CreativeError('静态人物图需要在服务设置中选择 sync-3；其他口型模型需要出镜视频')
        if (videoUrl) validateCreativeMedia(projectId, videoUrl, 'video')
        else validateCreativeMedia(projectId, shot.imageUrl, 'image')
        validateCreativeMedia(projectId, shot.audioUrl, 'audio')
        const audio = await deps.inspect(projectId, shot.audioUrl!, false)
        if (audio.duration == null || shot.audioTrimStart + shot.duration > audio.duration + 0.04)
          throw new CreativeError('镜头配音选段超过音频时长')
        if (videoUrl) {
          const video = await deps.inspect(projectId, videoUrl, false)
          if (video.duration == null || shot.trimStart + shot.duration > video.duration + 0.04)
            throw new CreativeError('口型画面选段超过视频时长')
        }
        data = {
          shotId: shot.id,
          shotMediaType: shot.mediaType,
          videoUrl: videoUrl ?? undefined,
          imageUrl: videoUrl ? undefined : (shot.imageUrl ?? undefined),
          audioUrl: shot.audioUrl!,
          trimStart: shot.trimStart,
          audioTrimStart: shot.audioTrimStart,
          duration: shot.duration,
          model: config.model,
        }
      } else if (kind === 'rigging') {
        const model = listCreativeModels(projectId).find((m) => m.id === request.modelId)
        if (!model) throw new CreativeError('请先上传并选择该项目的人形 GLB 模型')
        inspectGlb(await readModelFile(projectId, model.url))
        data = { modelId: model.id, modelUrl: model.url, height: request.height }
      } else {
        const query = request.query?.trim()
        if (!query) throw new CreativeError('请填写搜索内容')
        data = {
          query,
          media: request.media,
          orientation: { '16:9': 'landscape', '9:16': 'portrait', '1:1': 'square' }[project.aspectRatio],
        }
      }
      requireCreativeRevision(projectId, revision)
      data.configId = config.id
      const fingerprint = createHash('sha256').update(JSON.stringify({ kind, data })).digest('hex')
      const existing = db
        .select()
        .from(schema.creativeToolJobs)
        .where(
          and(
            eq(schema.creativeToolJobs.projectId, projectId),
            eq(schema.creativeToolJobs.kind, kind),
            eq(schema.creativeToolJobs.fingerprint, fingerprint),
          ),
        )
        .orderBy(desc(schema.creativeToolJobs.id))
        .get()
      if (existing && (!force || ['queued', 'submitting', 'running', 'uncertain'].includes(existing.status)))
        return publicToolJob(existing)
      const id = getInsertId(
        db
          .insert(schema.creativeToolJobs)
          .values({
            projectId,
            revision,
            kind,
            fingerprint,
            input: JSON.stringify(data),
            status: 'queued',
            createdAt: ts(),
            updatedAt: ts(),
          })
          .run(),
      )
      const row = rowFor(projectId, id)
      launch(row)
      return publicToolJob(current(row))
    },
    acknowledgeResubmission(projectId: number, id: number) {
      const row = rowFor(projectId,id)
      if (workers.has(id) || !['failed','uncertain'].includes(row.status)) throw new CreativeError('原任务仍在执行或已完成，不能重复提交',409)
      update(row,{status:'failed',error:'用户核对后确认重新提交；原任务记录保留',result:JSON.stringify({...result(row),submissionStarted:false,resubmissionAcknowledgedAt:ts()})})
    },
    resume(projectId: number, id: number, remoteId?: string) {
      const row = rowFor(projectId, id)
      if (workers.has(id)) return publicToolJob(row)
      if (row.status === 'completed') return publicToolJob(row)
      if (!row.remoteId && row.status === 'uncertain' && !remoteId)
        throw new CreativeError('提交结果未知，请从服务商后台找到该任务编号后恢复，避免重复计费', 409)
      if (remoteId) {
        if (!['uncertain', 'failed'].includes(row.status) || row.remoteId)
          throw new CreativeError('当前任务不能更换远端编号')
        idSchema.parse(remoteId)
        update(row, { remoteId, status: 'running', error: null })
      } else update(row, { status: row.remoteId ? 'running' : 'queued', error: null })
      saveResult(row, { pollUntil: Date.now() + 6 * 60 * 60 * 1000 })
      launch(current(row))
      return publicToolJob(current(row))
    },
    recover() {
      const rows = db
        .select()
        .from(schema.creativeToolJobs)
        .where(inArray(schema.creativeToolJobs.status, ['queued', 'submitting', 'running']))
        .all()
      for (const row of rows) {
        try {
          getCreativeProject(row.projectId)
          if (!row.remoteId && result(row).submissionStarted)
            update(row, { status: 'uncertain', error: '服务重启时提交结果未知，请核对服务商任务编号后恢复' })
          else launch(row)
        } catch {
          /* deleted project */
        }
      }
    },
    async idle(id: number) {
      await workers.get(id)
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}
export const creativeToolService = createToolService()

export async function applyLipSync(
  projectId: number,
  id: number,
  revision: number,
  preserveApproval = false,
) {
  const row = rowFor(projectId, id),
    data = input(row),
    file = result(row).files?.find((f) => f.kind === 'video')
  if (row.kind !== 'lipsync' || row.status !== 'completed' || !file)
    throw new CreativeError('口型任务尚未完成')
  return withCreativeMutation(projectId, () => {
    const project = requireCreativeRevision(projectId, revision),
      shot = project.shots.find((s) => s.id === data.shotId)
    if (shot?.videoUrl === file.url) return project
    if (
      !shot ||
      (data.shotMediaType && shot.mediaType !== data.shotMediaType) ||
      (shot.mediaType === 'video' ? shot.videoUrl : null) !== (data.videoUrl ?? null) ||
      (!data.videoUrl && shot.imageUrl !== data.imageUrl) ||
      shot.audioUrl !== data.audioUrl ||
      shot.trimStart !== data.trimStart ||
      shot.audioTrimStart !== data.audioTrimStart ||
      shot.duration !== data.duration
    )
      throw new CreativeError('镜头输入已变化，请重新制作口型；旧成片仍可下载', 409)
    const saved = saveCreativeProject(projectId, {
      ...project,
      shots: project.shots.map((s) =>
        s.id === shot.id
          ? {
              ...s,
              mediaType: 'video',
              videoUrl: file.url,
              videoTaskId: null,
              trimStart: 0,
              originalVolume: 0,
            }
          : s,
      ),
    })
    update(row, { result: JSON.stringify({ ...result(row), appliedRevision: saved.revision }) })
    return preserveApproval && project.approvedRevision === revision
      ? approveCreativeProject(projectId, saved.revision)
      : saved
  })
}
export async function importStockCandidate(
  projectId: number,
  id: number,
  candidateId: string,
  revision: number,
  deps: ToolDependencies = toolDependencies,
) {
  const row = rowFor(projectId, id),
    candidate = result(row).candidates?.find((c) => c.id === candidateId)
  if (row.kind !== 'stock' || row.status !== 'completed' || !candidate)
    throw new CreativeError('素材候选不存在', 404)
  const project = requireCreativeRevision(projectId, revision),
    imported = result(row).imports?.[candidateId]
  if (imported && project.production.sources.some((s) => s.id === imported)) return project
  if (project.production.sources.length >= 50)
    throw new CreativeError('项目素材已达到50个，请移除不需要的素材后再导入')
  const bytes = await deps.bytes(candidate.url, ['pexels.com'], 512 * 1024 * 1024)
  const url = await writeToolFile(projectId, bytes, candidate.kind === 'video' ? 'mp4' : 'jpg')
  let cover: string | null = null
  try {
    const info = await deps.inspect(projectId, url)
    cover = info.coverUrl
    if (info.kind !== candidate.kind) throw new CreativeError('下载素材与候选类型不一致', 422)
    const source = {
      id: randomUUID(),
      name: candidate.title.slice(0, 200),
      url,
      ...info,
      transcript: '',
      attribution: `${candidate.author} · Pexels\n${candidate.pageUrl}\n${candidate.authorUrl}\n许可：${candidate.licenseUrl}\n下载时间：${ts()}`,
    }
    return await withCreativeMutation(projectId, () => {
      const fresh = requireCreativeRevision(projectId, revision)
      const saved = saveCreativeProject(
        projectId,
        { ...fresh, production: { ...fresh.production, sources: [...fresh.production.sources, source] } },
        source,
      )
      update(row, {
        result: JSON.stringify({
          ...result(currentRow()),
          imports: { ...result(currentRow()).imports, [candidateId]: source.id },
        }),
      })
      return saved
    })
  } catch (error) {
    await Promise.allSettled(
      [url, cover].filter((s): s is string => !!s).map((s) => fs.rm(mediaPath(s), { force: true })),
    )
    throw error
  }
  function currentRow() {
    return rowFor(projectId, id)
  }
}
