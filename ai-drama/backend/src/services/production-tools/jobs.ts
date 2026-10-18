import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { and, eq, desc, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db, getInsertId, schema } from '../../db/index.js'
import { STORAGE_ROOT } from '../../utils/paths.js'
import { CreativeError, revisionSchema } from '../creative-model.js'
import {
  getCreativeProject,
  requireCreativeRevision,
  withCreativeMutation,
  saveCreativeProject,
} from '../creative-projects.js'
import { parseCreativeSrt } from '../creative-sources.js'
import { uploadCreativeModel } from '../creative-tools/jobs.js'
import { inspectCreativeSource } from '../creative-renderer.js'
import { getConfigById, getActiveConfig } from '../ai.js'
import { getToolDefinition, toolboxProviderPresets } from './catalog.js'
import { executeTool } from './executor.js'
import type { ToolContext, ToolOutput, ToolFileKind } from './contracts.js'

type Row = typeof schema.productionToolJobs.$inferSelect
const ts = () => new Date().toISOString()
const active = ['queued', 'running']
const pending = new Map<number, { controller: AbortController; work: Promise<void> }>()
/** A synchronous response is enough to resume local materialization without another paid request. */
function hasKnownResult(state: Record<string, unknown>) {
  return ['syncResult', 'searchResult', 'transcriptionResult'].some(
    (key) => state[key] !== null && typeof state[key] === 'object',
  )
}
export const startToolboxSchema = z
  .object({
    revision: revisionSchema,
    toolId: z
      .string()
      .regex(/^[a-z0-9_]+$/)
      .max(100),
    args: z.record(z.string().max(80), z.unknown()).default({}),
    configId: z.number().int().positive().optional(),
    force: z.boolean().default(false),
  })
  .strict()
function rowFor(projectId: number, id: number) {
  getCreativeProject(projectId)
  const row = db
    .select()
    .from(schema.productionToolJobs)
    .where(and(eq(schema.productionToolJobs.id, id), eq(schema.productionToolJobs.projectId, projectId)))
    .get()
  if (!row) throw new CreativeError('制作工具任务不存在', 404)
  return row
}
function patch(id: number, value: Partial<Row>) {
  db.update(schema.productionToolJobs)
    .set({ ...value, updatedAt: ts() })
    .where(eq(schema.productionToolJobs.id, id))
    .run()
}
export function publicToolboxJob(row: Row) {
  const { state, fingerprint, input, result, ...rest } = row
  return {
    ...rest,
    input: JSON.parse(input),
    result: JSON.parse(result),
    remoteId: JSON.parse(state).remoteId ?? null,
  }
}
export function listToolboxJobs(projectId: number) {
  getCreativeProject(projectId)
  return db
    .select()
    .from(schema.productionToolJobs)
    .where(eq(schema.productionToolJobs.projectId, projectId))
    .orderBy(desc(schema.productionToolJobs.id))
    .limit(100)
    .all()
    .map(publicToolboxJob)
}
const inside = (root: string, file: string) => file.startsWith(root + path.sep)
function safeError(error: unknown, key?: string) {
  let message =
    error instanceof Error &&
    (/^(请|需要|上次|等待|配音|Google|可灵|百炼|录音|缺少|当前|此|该|无法|未|服务|原|输出|输入|工作|ComfyUI|Fal|Replicate|Blender|Piper|yt-dlp|FFmpeg|SVG|三维|媒体|视频|音频|工具|人脸|模型)/.test(
      error.message,
    ) ||
      error instanceof CreativeError)
      ? error.message
      : '制作工具执行失败，请检查素材、服务配置和运行环境后重试'
  if (key) message = message.split(key).join('[已隐藏]')
  return message.replace(/([?&](?:key|token|signature|api_key)=)[^&\s]+/gi, '$1[已隐藏]').slice(0, 600)
}
export async function outputFiles(folder: string, output: ToolOutput) {
  const root = await fs.realpath(folder)
  if (
    !output ||
    typeof output.summary !== 'string' ||
    !Array.isArray(output.files) ||
    output.files.length > 100
  )
    throw new CreativeError('工具返回了无效产物', 422)
  const files: { url: string; name: string; kind: ToolFileKind }[] = []
  for (const file of output.files) {
    const real = await fs.realpath(file.path)
    const stat = await fs.stat(real)
    if (!inside(root, real) || !stat.isFile() || !stat.size || stat.size > 1024 * 1024 * 1024)
      throw new CreativeError('工具产物为空、过大或越过项目目录', 422)
    files.push({
      url:
        '/static/' +
        path
          .relative(await fs.realpath(STORAGE_ROOT), real)
          .split(path.sep)
          .join('/'),
      name: path.basename(file.name).slice(0, 200),
      kind: file.kind,
    })
  }
  if (!files.length && !output.data) throw new CreativeError('工具未返回可使用的结果', 422)
  const result = { summary: output.summary.slice(0, 3000), files, data: output.data ?? {} }
  if (JSON.stringify(result).length > 2_000_000) throw new CreativeError('工具结果过大，请分批处理', 422)
  return result
}
export type ToolExecutor = (context: ToolContext) => Promise<ToolOutput>
export function createToolboxService(executor: ToolExecutor = executeTool) {
  async function launch(row: Row) {
    if (pending.has(row.id)) return
    const controller = new AbortController()
    const work = (async () => {
      let config: Awaited<ReturnType<typeof getConfigById>> = null
      try {
        const input = JSON.parse(row.input) as z.infer<typeof startToolboxSchema>
        const definition = getToolDefinition(row.toolId)
        if (input.configId) {
          config = await getConfigById(input.configId, definition.serviceType)
          if (!config || (definition.provider !== 'shared' && config.provider !== definition.provider))
            throw new CreativeError('任务原服务配置已停用或删除，请恢复该配置后继续', 503)
        }
        const storageRoot = await fs.realpath(STORAGE_ROOT)
        const folder = path.join(storageRoot, 'creative', String(row.projectId), 'toolbox', String(row.id))
        await fs.mkdir(folder, { recursive: true })
        if (!inside(storageRoot, await fs.realpath(folder))) throw new CreativeError('制作目录无效')
        const state = JSON.parse(row.state) as Record<string, unknown>
        if (
          config &&
          state.endpointHash &&
          state.endpointHash !==
            createHash('sha256')
              .update(JSON.stringify([config.provider, config.baseUrl]))
              .digest('hex')
        )
          throw new CreativeError('任务原服务地址已改变，请恢复原配置后再继续', 503)
        if (config)
          config = {
            ...config,
            model: typeof state.selectedModel === 'string' ? state.selectedModel : config.model,
            serviceOptions:
              state.serviceOptions && typeof state.serviceOptions === 'object'
                ? (state.serviceOptions as Record<string, unknown>)
                : config.serviceOptions,
          }
        const checkpoint = (value: Record<string, unknown>) => {
          Object.assign(state, value)
          patch(row.id, { state: JSON.stringify(state) })
        }
        getCreativeProject(row.projectId)
        if (controller.signal.aborted) return
        patch(row.id, { status: 'running', error: null })
        const output = await executor({
          projectId: row.projectId,
          toolId: row.toolId,
          args: input.args,
          outputDir: folder,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6 * 60 * 60 * 1000)]),
          config: config ?? undefined,
          state,
          checkpoint,
          progress: (value) => {
            if (Number.isFinite(value) && !controller.signal.aborted)
              patch(row.id, { progress: Math.max(0, Math.min(99, Math.floor(value))) })
          },
        })
        if (controller.signal.aborted) return
        getCreativeProject(row.projectId)
        const result = await outputFiles(folder, output)
        patch(row.id, { status: 'completed', progress: 100, result: JSON.stringify(result), error: null })
      } catch (error) {
        if (controller.signal.aborted) return
        const latest = db
          .select()
          .from(schema.productionToolJobs)
          .where(eq(schema.productionToolJobs.id, row.id))
          .get()
        if (!latest) return
        const state = JSON.parse(latest.state)
        const uncertain =
          state.submissionStarted &&
          !state.remoteId &&
          !state.taskId &&
          !state.rejected &&
          !hasKnownResult(state)
        patch(row.id, { status: uncertain ? 'uncertain' : 'failed', error: safeError(error, config?.apiKey) })
      }
    })()
    pending.set(row.id, { controller, work })
    void work.finally(() => pending.delete(row.id))
  }
  return {
    async start(projectId: number, raw: unknown) {
      const input = startToolboxSchema.parse(raw)
      requireCreativeRevision(projectId, input.revision)
      if (
        /"(?:api_key|apiKey|authorization|secret|secret_key|secretKey|client_secret|clientSecret|api_secret|apiSecret|access_token|accessToken|refresh_token|refreshToken)"\s*:/i.test(
          JSON.stringify(input.args),
        )
      )
        throw new CreativeError('请在模型与服务管理密钥，不能将密钥放入工具参数')
      if (JSON.stringify(input.args).length > 200_000) throw new CreativeError('工具参数过大，请分批执行')
      const definition = getToolDefinition(input.toolId)
      if (!definition.implemented)
        throw new CreativeError(definition.reason || '该工具尚未具备可执行适配器', 503)
      for (const field of definition.inputs)
        if (field.required && (input.args[field.key] == null || input.args[field.key] === ''))
          throw new CreativeError(`请填写${field.label}`)
      let config = input.configId ? await getConfigById(input.configId, definition.serviceType) : null
      if (!config && !input.configId && definition.serviceType) {
        if (definition.provider === 'shared') config = await getActiveConfig(definition.serviceType)
        else {
          const rows = db
            .select()
            .from(schema.aiServiceConfigs)
            .where(
              and(
                eq(schema.aiServiceConfigs.serviceType, definition.serviceType),
                eq(schema.aiServiceConfigs.provider, definition.provider),
              ),
            )
            .all()
            .filter((row) => row.isActive)
            .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id - b.id)
          if (rows[0]) config = await getConfigById(rows[0].id, definition.serviceType)
        }
      }
      const publicProvider = ['nasa', 'wikimedia', 'archive_org', 'loc'].includes(definition.provider)
      if (input.configId && !config) throw new CreativeError('所选配置已停用、被删除或能力不符')
      if (definition.serviceType && !config && !publicProvider)
        throw new CreativeError('请先在模型与服务中启用该工具的服务配置', 503)
      if (config && definition.provider !== 'shared' && config.provider !== definition.provider)
        throw new CreativeError('所选服务商与该工具不匹配')
      const keyRequired =
        toolboxProviderPresets().find(
          (p) =>
            p.provider === (config?.provider ?? definition.provider) &&
            p.serviceType === definition.serviceType,
        )?.requiresApiKey !== false
      if (config && keyRequired && !config.apiKey)
        throw new CreativeError('服务尚未填写 API Key，请在模型与服务中补充', 503)
      if (config) input.configId = config.id
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            toolId: input.toolId,
            args: input.args,
            configId: input.configId,
            model: config?.model,
            serviceOptions: config?.serviceOptions,
          }),
        )
        .digest('hex')
      const existing = db
        .select()
        .from(schema.productionToolJobs)
        .where(
          and(
            eq(schema.productionToolJobs.projectId, projectId),
            eq(schema.productionToolJobs.fingerprint, fingerprint),
          ),
        )
        .orderBy(desc(schema.productionToolJobs.id))
        .get()
      if (existing && (!input.force || [...active, 'uncertain'].includes(existing.status)))
        return publicToolboxJob(existing)
      const running = db
        .select()
        .from(schema.productionToolJobs)
        .where(
          and(
            eq(schema.productionToolJobs.projectId, projectId),
            inArray(schema.productionToolJobs.status, active),
          ),
        )
        .all()
      if (running.length >= 3)
        throw new CreativeError('当前项目已有三个工具任务执行中，请等待完成后继续', 409)
      requireCreativeRevision(projectId, input.revision)
      const id = getInsertId(
        db
          .insert(schema.productionToolJobs)
          .values({
            projectId,
            toolId: input.toolId,
            fingerprint,
            revision: input.revision,
            input: JSON.stringify(input),
            state: JSON.stringify(
              config
                ? {
                    endpointHash: createHash('sha256')
                      .update(JSON.stringify([config.provider, config.baseUrl]))
                      .digest('hex'),
                    serviceOptions: config.serviceOptions ?? {},
                    selectedModel: config.model,
                  }
                : {},
            ),
            createdAt: ts(),
            updatedAt: ts(),
          })
          .run(),
      )
      const row = rowFor(projectId, id)
      void launch(row)
      return publicToolboxJob(row)
    },
    resume(projectId: number, id: number, remoteId?: string, retrySubmission = false) {
      const row = rowFor(projectId, id)
      if (pending.has(id) || row.status === 'completed') return publicToolboxJob(row)
      let state = JSON.parse(row.state)
      if (retrySubmission) {
        if (!['failed', 'uncertain', 'cancelled'].includes(row.status))
          throw new CreativeError('当前任务不能重新提交')
        state = {
          replacesLegacyJobId: state.legacyJobId,
          endpointHash: state.endpointHash,
          serviceOptions: state.serviceOptions,
          selectedModel: state.selectedModel,
          submissionStarted: false,
          attempts: [
            ...(Array.isArray(state.attempts) ? state.attempts : []),
            { remoteId: state.remoteId, taskId: state.taskId, status: row.status, at: ts() },
          ].slice(-20),
        }
      }
      if (row.status === 'uncertain' && !remoteId && !retrySubmission && !hasKnownResult(state))
        throw new CreativeError('提交结果未知，请填入服务商任务编号后恢复查询', 409)
      state.pollStarted = Date.now()
      if (remoteId) {
        if (state.remoteId && state.remoteId !== remoteId)
          throw new CreativeError('不能更换已记录的服务商任务编号')
        if (!/^[a-zA-Z0-9_.:/-]{1,500}$/.test(remoteId)) throw new CreativeError('服务商任务编号格式不正确')
        state.remoteId = remoteId
      }
      if (
        state.submissionStarted &&
        !state.remoteId &&
        !state.taskId &&
        !state.rejected &&
        !hasKnownResult(state)
      )
        throw new CreativeError('请先核对服务商是否已受理，避免重复提交', 409)
      patch(id, { status: 'queued', error: null, state: JSON.stringify(state) })
      void launch(rowFor(projectId, id))
      return publicToolboxJob(rowFor(projectId, id))
    },
    cancel(projectId: number, id: number) {
      const row = rowFor(projectId, id)
      if (![...active, 'uncertain'].includes(row.status)) return publicToolboxJob(row)
      pending.get(id)?.controller.abort()
      patch(id, {
        status: 'cancelled',
        error: '已停止本地处理或查询；服务商已受理的任务仍可在其后台继续运行',
      })
      return publicToolboxJob(rowFor(projectId, id))
    },
    recover() {
      for (const row of db
        .select()
        .from(schema.productionToolJobs)
        .where(inArray(schema.productionToolJobs.status, active))
        .all()) {
        const state = JSON.parse(row.state)
        if (
          state.submissionStarted &&
          !state.remoteId &&
          !state.taskId &&
          !state.rejected &&
          !hasKnownResult(state)
        )
          patch(row.id, { status: 'uncertain', error: '服务重启时提交结果未知，请核对服务商任务编号后恢复' })
        else patch(row.id, { status: 'failed', error: '服务已重启，制作任务已保留，请恢复处理' })
      }
    },
    idle: async (id: number) => {
      await pending.get(id)?.work
    },
    dispose: () => {
      for (const job of pending.values()) job.controller.abort()
    },
  }
}
export const toolboxService = createToolboxService()
export async function applyToolboxOutput(projectId: number, id: number, raw: unknown) {
  const input = z
    .object({
      revision: revisionSchema,
      fileUrl: z.string().optional(),
      shotId: z.string().optional(),
      sourceId: z.string().uuid().optional(),
      sourceName: z.string().trim().min(1).max(200).optional(),
    })
    .strict()
    .parse(raw)
  return withCreativeMutation(projectId, async () => {
    const project = requireCreativeRevision(projectId, input.revision)
    const row = rowFor(projectId, id)
    if (row.status !== 'completed') throw new CreativeError('制作尚未完成，请等待产物生成')
    const result = JSON.parse(row.result) as {
      summary: string
      files: { url: string; name: string; kind: ToolFileKind }[]
      data?: Record<string, unknown>
    }
    const file = input.fileUrl
      ? result.files.find((file) => file.url === input.fileUrl)
      : result.files.length === 1
        ? result.files[0]
        : undefined
    if (!file) throw new CreativeError('请选择这项任务中的一个产物')
    if (file.kind === 'model') {
      if (!file.url.endsWith('.glb')) throw new CreativeError('三维模型库当前支持GLB，其余格式可下载使用')
      const bytes = await fs.readFile(path.join(STORAGE_ROOT, file.url.slice('/static/'.length)))
      const metadata = JSON.parse(row.state)
      if (!metadata.importedModelId) {
        const model = await uploadCreativeModel(projectId, file.name, bytes)
        patch(id, { state: JSON.stringify({ ...metadata, importedModelId: model.id }) })
      }
      return getCreativeProject(projectId)
    }
    if (file.kind === 'subtitle') {
      const source = project.production.sources.find((source) => source.id === input.sourceId)
      if (!source || source.kind === 'image' || !source.duration)
        throw new CreativeError('请选择字幕对应的视频或音频来源')
      const subtitlePath = path.join(STORAGE_ROOT, file.url.slice('/static/'.length))
      if ((await fs.stat(subtitlePath)).size > 400000) throw new CreativeError('字幕文件不能超过 10 万字符')
      let transcript = await fs.readFile(subtitlePath, 'utf8')
      if (file.url.endsWith('.json')) {
        let value: unknown
        try {
          value = JSON.parse(transcript)
        } catch {
          throw new CreativeError('字幕 JSON 格式无效')
        }
        const parsed = z
          .array(
            z
              .object({
                start: z.number().finite().min(0).max(3600),
                end: z.number().finite().positive().max(3600),
                text: z
                  .string()
                  .trim()
                  .min(1)
                  .max(3000)
                  .refine((text) => !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)),
              })
              .strict(),
          )
          .min(1)
          .max(2000)
          .safeParse(value)
        if (!parsed.success) throw new CreativeError('字幕 JSON 须为有效的 start、end、text 片段列表')
        const timestamp = (seconds: number) => {
          const ms = Math.round(seconds * 1000)
          return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
        }
        transcript = parsed.data
          .map(
            (cue, index) =>
              `${index + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${cue.text.replace(/\r\n?/g, '\n').replace(/\n\s*\n+/g, '\n')}`,
          )
          .join('\n\n')
      } else if (file.url.endsWith('.vtt')) {
        const blocks = transcript
          .replace(/^\uFEFF/, '')
          .replace(/\r/g, '')
          .replace(/^WEBVTT[^\n]*\n/, '')
          .trim()
          .split(/\n\s*\n/)
        transcript = blocks
          .flatMap((block) => {
            const lines = block.split('\n'),
              line = lines.findIndex((line) => line.includes('-->'))
            if (line < 0) return []
            const match = lines[line].match(
              /((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})\s*-->\s*((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})/,
            )
            if (!match) throw new CreativeError('VTT字幕时码无效')
            const time = (value: string) =>
              (value.split(':').length === 2 ? '00:' : '') + value.replace('.', ',')
            return [`${time(match[1])} --> ${time(match[2])}\n${lines.slice(line + 1).join('\n')}`]
          })
          .map((block, index) => `${index + 1}\n${block}`)
          .join('\n\n')
      }
      const segments = parseCreativeSrt(transcript)
      if (source.duration && segments.some((segment) => segment.end > source.duration! + 0.1))
        throw new CreativeError('字幕时码超过所选来源时长')
      if (source.transcript === transcript) return project
      return saveCreativeProject(projectId, {
        ...project,
        production: {
          ...project.production,
          sources: project.production.sources.map((item) =>
            item.id === source.id ? { ...item, transcript } : item,
          ),
        },
      })
    }
    if (!['image', 'video', 'audio'].includes(file.kind))
      throw new CreativeError('此产物可下载查看；只有图片、视频和音频可直接导入项目')
    const info = await inspectCreativeSource(projectId, file.url)
    if (info.kind !== file.kind) throw new CreativeError('产物的实际格式与记录不符', 422)
    if (input.shotId) {
      const shot = project.shots.find((shot) => shot.id === input.shotId)
      if (!shot) throw new CreativeError('镜头不存在', 404)
      if (info.duration && file.kind !== 'image' && info.duration + 0.04 < shot.duration)
        throw new CreativeError('产物短于当前镜头，请先调整镜头时长')
      const shots = project.shots.map((shot) =>
        shot.id !== input.shotId
          ? shot
          : file.kind === 'audio'
            ? { ...shot, audioUrl: file.url, audioTrimStart: 0 }
            : {
                ...shot,
                mediaType: file.kind as 'image' | 'video',
                imageUrl: file.kind === 'image' ? file.url : shot.imageUrl,
                videoUrl: file.kind === 'video' ? file.url : shot.videoUrl,
                trimStart: 0,
              },
      )
      return saveCreativeProject(projectId, { ...project, shots })
    }
    if (project.production.sources.some((source) => source.url === file.url)) return project
    const attribution =
      typeof result.data?.attribution === 'string' ? result.data.attribution.slice(0, 2000) : ''
    const source = {
      id: randomUUID(),
      name: input.sourceName || file.name,
      url: file.url,
      ...info,
      transcript: '',
      attribution,
    }
    return saveCreativeProject(
      projectId,
      { ...project, production: { ...project.production, sources: [...project.production.sources, source] } },
      source,
    )
  })
}
