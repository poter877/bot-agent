import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '../../db/index.js'
import { STORAGE_ROOT } from '../../utils/paths.js'
import { ffmpegPath } from '../../utils/ffmpeg.js'
import { generateImage, generateVideo, resumeGenerationTask } from '../generation.js'
import { validateCreativeMedia, getCreativeProject } from '../creative-projects.js'
import { CreativeError } from '../creative-model.js'
import { renderCreativeVideo, inspectCreativeSource } from '../creative-renderer.js'
import { creativeToolService, getToolJob } from '../creative-tools/jobs.js'
import { runProviderTool, providerToolSpecs, providerPresets } from './providers.js'
import {
  checkpoint,
  ensureCanSubmit,
  jsonRequest,
  providerDependencies,
  serviceUrl,
} from './provider-runtime.js'
import { SAFE_INPUT } from './local-core.js'
import { runLocalTool, LOCAL_TOOL_IDS } from './local.js'
import { runAuxiliaryTool, auxiliaryIds } from './auxiliary.js'
import { sharedToolSpecs } from './catalog.js'
import type { ToolContext, ToolOutput } from './contracts.js'
const delay = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted()
    const end = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
      },
      abort = () => {
        end()
        reject(signal.reason)
      },
      timer = setTimeout(() => {
        end()
        resolve()
      }, 1000)
    signal.addEventListener('abort', abort, { once: true })
  })
function text(args: Record<string, unknown>, key: string, fallback = '') {
  return typeof args[key] === 'string' ? String(args[key]).trim() : fallback
}
function uri(file: string) {
  return file.startsWith('/static/') ? file : '/' + file
}
async function copied(
  ctx: ToolContext,
  url: string,
  kind: 'image' | 'video' | 'audio',
): Promise<ToolOutput['files'][number]> {
  validateCreativeMedia(ctx.projectId, uri(url), kind)
  const original = path.join(STORAGE_ROOT, uri(url).slice('/static/'.length)),
    name = `generated${path.extname(original)}`,
    destination = path.join(ctx.outputDir, name)
  await fs.copyFile(original, destination)
  return { path: destination, name, kind }
}
export async function runUnifiedGeneration(ctx: ToolContext, kind: 'image' | 'video'): Promise<ToolOutput> {
  let id = typeof ctx.state.taskId === 'number' ? ctx.state.taskId : undefined
  if (!id && typeof ctx.state.remoteId === 'string') {
    const remote = ctx.state.remoteId
    const row = /^\d+$/.test(remote)
      ? db
          .select()
          .from(schema.sysTask)
          .where(eq(schema.sysTask.id, Number(remote)))
          .get()
      : db
          .select()
          .from(schema.sysTask)
          .where(eq(schema.sysTask.taskId, remote))
          .all()
          .find((row) => row.dramaId === ctx.projectId && row.type === kind)
    if (!row || row.dramaId !== ctx.projectId || row.type !== kind)
      throw new CreativeError('恢复的生成任务不属于此项目或类型不符')
    id = row.id
    ctx.checkpoint({ taskId: id })
  }
  if (id) {
    const existing = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()
    if (existing?.status === 'failed' && existing.taskId) await resumeGenerationTask(id)
  }
  if (!id) {
    if (ctx.state.submissionStarted && !ctx.state.rejected)
      throw new CreativeError('生成提交结果未知，请核对已有任务后处理', 409)
    const prompt = text(ctx.args, 'prompt')
    if (!prompt) throw new CreativeError('请填写生成描述')
    const image = text(ctx.args, 'image_url')
    if (image) validateCreativeMedia(ctx.projectId, image, 'image')
    ctx.checkpoint({ submissionStarted: true })
    id =
      kind === 'image'
        ? await generateImage({
            dramaId: ctx.projectId,
            prompt,
            configId: ctx.config?.id,
            model: ctx.config?.model,
            size: text(ctx.args, 'size', '1536x864'),
            referenceImages: image ? [image] : [],
          })
        : await generateVideo({
            dramaId: ctx.projectId,
            prompt,
            configId: ctx.config?.id,
            model: ctx.config?.model,
            duration: Number(ctx.args.duration ?? 5),
            aspectRatio: text(ctx.args, 'aspect_ratio', '16:9'),
            firstFrameUrl: image || undefined,
            referenceMode: image ? 'first_frame' : 'reference',
          })
    ctx.checkpoint({ taskId: id })
  }
  while (true) {
    ctx.signal.throwIfAborted()
    const row = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()
    if (!row || row.dramaId !== ctx.projectId || row.type !== kind)
      throw new CreativeError('关联生成任务不存在或不属于该项目', 404)
    if (row.status === 'completed' && row.localPath)
      return {
        summary: `${kind === 'image' ? '图片' : '视频'}已由统一生成服务完成`,
        files: [await copied(ctx, row.localPath, kind)],
        data: { taskId: id, provider: row.provider, model: row.model },
      }
    if (['failed', 'cancelled'].includes(row.status ?? ''))
      throw new CreativeError(row.errorMsg || '统一生成任务失败', 503)
    ctx.progress(20)
    await delay(ctx.signal)
  }
}
async function runTranscription(ctx: ToolContext): Promise<ToolOutput> {
  const sourceUrl = text(ctx.args, 'sourceUrl') || text(ctx.args, 'input_path')
  const kind = /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(sourceUrl) ? 'audio' : 'video'
  validateCreativeMedia(ctx.projectId, sourceUrl, kind)
  const config = ctx.config
  if (!config || config.provider !== 'openai') throw new CreativeError('请配置 OpenAI 字幕时码识别服务', 503)
  let data = ctx.state.transcriptionResult as any
  if (!data) {
    ensureCanSubmit(ctx)
    const mp3 = path.join(ctx.outputDir, 'transcription-input.mp3')
    await new Promise<void>((resolve, reject) =>
      execFile(
        ffmpegPath || 'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-y',
          ...SAFE_INPUT,
          '-i',
          path.join(STORAGE_ROOT, sourceUrl.slice('/static/'.length)),
          '-map',
          '0:a:0',
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-b:a',
          '32k',
          mp3,
        ],
        { timeout: 180000, maxBuffer: 1024 * 1024, signal: ctx.signal },
        (error) => (error ? reject(new CreativeError('语音抽取失败，请检查原片音轨', 422)) : resolve()),
      ),
    )
    const bytes = await fs.readFile(mp3)
    if (bytes.length > 24 * 1024 * 1024) throw new CreativeError('音频超过识别大小限制，请先裁剪')
    const form = new FormData()
    form.set('file', new Blob([new Uint8Array(bytes)], { type: 'audio/mpeg' }), 'source.mp3')
    form.set('model', config.model || 'whisper-1')
    form.set('response_format', 'verbose_json')
    form.append('timestamp_granularities[]', 'segment')
    checkpoint(ctx, { submissionStarted: true })
    data = await jsonRequest(
      ctx,
      providerDependencies,
      serviceUrl(config, '/audio/transcriptions', '/v1'),
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body: form,
      },
      8 * 1024 * 1024,
    )
    checkpoint(ctx, { transcriptionResult: data, submissionStarted: false })
  }
  if (!Array.isArray(data.segments) || !data.segments.length)
    throw new CreativeError('识别服务没有返回真实时码', 422)
  const stamp = (s: number) => {
    const ms = Math.round(s * 1000)
    return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
  }
  let last = 0
  const srt = data.segments
    .map((segment: any, index: number) => {
      if (
        !Number.isFinite(segment.start) ||
        !Number.isFinite(segment.end) ||
        segment.start < last ||
        segment.end <= segment.start ||
        typeof segment.text !== 'string'
      )
        throw new CreativeError('识别时码无效', 422)
      last = segment.end
      return `${index + 1}\n${stamp(segment.start)} --> ${stamp(segment.end)}\n${segment.text.trim()}\n`
    })
    .join('\n')
  const file = path.join(ctx.outputDir, 'transcript.srt')
  await fs.writeFile(file, srt)
  return {
    summary: '已识别真实原声与字幕时码',
    files: [{ path: file, name: 'transcript.srt', kind: 'subtitle' }],
    data: { text: String(data.text || ''), sourceUrl },
  }
}
async function runPiper(ctx: ToolContext): Promise<ToolOutput> {
  const line = text(ctx.args, 'text')
  if (!line || line.length > 10000) throw new CreativeError('请输入不超过10000字的配音文字')
  const model = process.env.PIPER_MODEL
  if (!model) throw new CreativeError('请安装 Piper，并配置 PIPER_MODEL 和可选 PIPER_BIN，启用离线配音', 503)
  await fs.access(model)
  const file = path.join(ctx.outputDir, 'piper-voice.wav'),
    args = ['--model', model, '--output_file', file]
  if (ctx.args.speaker != null) {
    const speaker = Number(ctx.args.speaker)
    if (!Number.isInteger(speaker) || speaker < 0 || speaker > 10000) throw new CreativeError('音色编号无效')
    args.push('--speaker', String(speaker))
  }
  await new Promise<void>((resolve, reject) => {
    const process = spawn(globalThis.process.env.PIPER_BIN || 'piper', args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      signal: ctx.signal,
      timeout: 180000,
    })
    let size = 0
    process.stderr.on('data', (chunk) => {
      size += chunk.length
      if (size > 1024 * 1024) process.kill()
    })
    process.on('error', () => reject(new CreativeError('Piper 不可用，请检查安装和音色模型', 503)))
    process.on('close', (code) =>
      code === 0 ? resolve() : reject(new CreativeError('Piper 配音失败，请检查音色模型', 503)),
    )
    process.stdin.end(line + '\n')
  })
  return { summary: '离线配音已完成', files: [{ path: file, name: 'piper-voice.wav', kind: 'audio' }] }
}
async function runLip(ctx: ToolContext): Promise<ToolOutput> {
  const project = getCreativeProject(ctx.projectId),
    shotId = text(ctx.args, 'shotId')
  if (!project.shots.some((shot) => shot.id === shotId))
    throw new CreativeError('请选择需要口型同步的人物镜头')
  let id = Number(ctx.state.legacyJobId) || undefined
  if (!id) {
    const resubmit = typeof ctx.state.replacesLegacyJobId === 'number'
    if (resubmit)
      creativeToolService.acknowledgeResubmission(ctx.projectId, ctx.state.replacesLegacyJobId as number)
    const job = await creativeToolService.start(
      ctx.projectId,
      project.revision,
      'lipsync',
      { shotId },
      resubmit,
      ctx.config?.id,
    )
    id = job.id
    ctx.checkpoint({ legacyJobId: id })
  }
  const legacy = getToolJob(ctx.projectId, id)
  if (typeof ctx.state.remoteId === 'string' && ['uncertain', 'failed'].includes(legacy.status))
    creativeToolService.resume(ctx.projectId, id, legacy.remoteId ? undefined : ctx.state.remoteId)
  else if (legacy.status === 'failed' && legacy.remoteId) creativeToolService.resume(ctx.projectId, id)
  while (true) {
    ctx.signal.throwIfAborted()
    const job = getToolJob(ctx.projectId, id)
    if (job.remoteId && ctx.state.remoteId !== job.remoteId) ctx.checkpoint({ remoteId: job.remoteId })
    if (job.status === 'completed')
      return {
        summary: '人物口型已完成，可选择成片应用到镜头',
        files: await Promise.all(
          (job.result.files || []).filter((f) => f.kind === 'video').map((f) => copied(ctx, f.url, 'video')),
        ),
        data: { legacyJobId: id },
      }
    if (job.status === 'uncertain') {
      ctx.checkpoint({ submissionStarted: true })
      throw new CreativeError(job.error || '口型提交结果未知，请在专项工具中填写任务编号恢复', 409)
    }
    if (job.status === 'failed') throw new CreativeError(job.error || '口型任务失败', 503)
    ctx.progress(job.progress)
    await delay(ctx.signal)
  }
}
export async function executeTool(ctx: ToolContext): Promise<ToolOutput> {
  if (ctx.args.parameters && typeof ctx.args.parameters === 'object' && !Array.isArray(ctx.args.parameters))
    ctx = { ...ctx, args: { ...(ctx.args.parameters as Record<string, unknown>), ...ctx.args } }
  if (
    ['video_compose', 'hyperframes_compose', 'video_stitch', 'bgm_montage_lite'].includes(ctx.toolId) &&
    ctx.args.timeline
  ) {
    const url = z.string().nullable().optional()
    const timeline = z
      .object({
        projectId: z.number().int().positive().optional(),
        title: z.string().max(200),
        aspectRatio: z.enum(['16:9', '9:16', '1:1']),
        shots: z
          .array(
            z
              .object({
                id: z.string().max(80),
                title: z.string().max(200),
                duration: z
                  .number()
                  .finite()
                  .min(1 / 30)
                  .max(600),
                mediaType: z.enum(['image', 'video']),
                imageUrl: url,
                videoUrl: url,
                caption: z.string().max(3000),
                trimStart: z.number().finite().min(0).optional(),
                audioUrl: url,
                audioTrimStart: z.number().finite().min(0).optional(),
                originalVolume: z.number().finite().min(0).max(2).optional(),
              })
              .strip(),
          )
          .min(1)
          .max(200),
        narrationUrl: url,
        musicUrl: url,
        musicVolume: z.number().finite().min(0).max(2).optional(),
        burnSubtitles: z.boolean().optional(),
      })
      .strip()
      .parse(ctx.args.timeline)
    if (timeline.projectId && timeline.projectId !== ctx.projectId)
      throw new CreativeError('合成时间线不属于当前项目')
    for (const shot of timeline.shots) {
      const source = shot.mediaType === 'image' ? shot.imageUrl : shot.videoUrl
      if (!source) throw new CreativeError(`镜头「${shot.title}」缺少素材`)
      validateCreativeMedia(ctx.projectId, source, shot.mediaType)
      validateCreativeMedia(ctx.projectId, shot.audioUrl ?? null, 'audio')
    }
    validateCreativeMedia(ctx.projectId, timeline.narrationUrl ?? null, 'audio')
    validateCreativeMedia(ctx.projectId, timeline.musicUrl ?? null, 'audio')
    if (ctx.toolId === 'bgm_montage_lite' || (ctx.args.transition && ctx.args.transition !== 'cut')) {
      const rhythm = ctx.toolId === 'bgm_montage_lite'
      if (rhythm && (timeline.narrationUrl || timeline.shots.some((shot) => !!shot.audioUrl)))
        throw new CreativeError('节拍混剪会重新安排镜头，不适合连续讲稿配音；请使用普通合成保留讲述时序')
      const prepared: string[] = []
      for (const shot of timeline.shots) {
        ctx.signal.throwIfAborted()
        const result = await renderCreativeVideo({
          projectId: ctx.projectId,
          title: shot.title,
          aspectRatio: timeline.aspectRatio,
          shots: [shot],
          burnSubtitles: timeline.burnSubtitles,
        })
        prepared.push('/' + result.videoUrl.replace(/^\//, ''))
      }
      const native = await runLocalTool({
        ...ctx,
        toolId: rhythm ? 'bgm_montage_lite' : 'video_stitch',
        outputDir: path.join(ctx.outputDir, 'native-composition'),
        args: {
          ...ctx.args,
          timeline: undefined,
          sourceUrls: prepared,
          musicUrl: timeline.musicUrl,
          music_volume: timeline.musicVolume ?? 0.2,
          preserve_original_audio: true,
          duration_seconds: Number(
            ctx.args.duration_seconds ?? timeline.shots.reduce((sum, shot) => sum + shot.duration, 0),
          ),
          ...{
            '16:9': { width: 1280, height: 720 },
            '9:16': { width: 720, height: 1280 },
            '1:1': { width: 720, height: 720 },
          }[timeline.aspectRatio],
        },
        progress: (value) => ctx.progress(value * 90),
      })
      const video = native.files.find((file) => file.kind === 'video')!
      let videoUrl =
        '/static/' +
        path
          .relative(await fs.realpath(STORAGE_ROOT), video.path)
          .split(path.sep)
          .join('/')
      const actual = await inspectCreativeSource(ctx.projectId, videoUrl, false)
      const segments: { start: number; end: number; text: string }[] = []
      if (rhythm) {
        for (const cut of (native.data?.cuts ?? []) as {
          sourceUrl: string
          start: number
          duration: number
        }[]) {
          const shot = timeline.shots[prepared.indexOf(cut.sourceUrl)]
          if (shot?.caption.trim())
            segments.push({
              start: cut.start,
              end: Math.min(cut.start + cut.duration, actual.duration!),
              text: shot.caption,
            })
        }
      } else {
        const fade = Number(ctx.args.transition_duration ?? 0.5)
        let cursor = 0
        for (let i = 0; i < timeline.shots.length; i++) {
          const shot = timeline.shots[i],
            end = Math.min(
              cursor + shot.duration - (i < timeline.shots.length - 1 ? fade : 0),
              actual.duration!,
            )
          if (shot.caption.trim() && end > cursor) segments.push({ start: cursor, end, text: shot.caption })
          cursor += shot.duration - (i < timeline.shots.length - 1 ? fade : 0)
        }
      }
      let files = native.files
      if (!rhythm && (timeline.narrationUrl || timeline.musicUrl)) {
        const mixed = await renderCreativeVideo({
          projectId: ctx.projectId,
          title: timeline.title,
          aspectRatio: timeline.aspectRatio,
          shots: [
            {
              id: 'mixed',
              title: timeline.title,
              mediaType: 'video',
              videoUrl,
              duration: actual.duration!,
              caption: '',
              originalVolume: 1,
            },
          ],
          narrationUrl: timeline.narrationUrl,
          musicUrl: timeline.musicUrl,
          musicVolume: timeline.musicVolume,
        })
        files = [await copied(ctx, mixed.videoUrl, 'video')]
        videoUrl = '/' + mixed.videoUrl
      }
      if (segments.length) {
        const subtitles = await runLocalTool({
          ...ctx,
          toolId: 'subtitle_gen',
          outputDir: path.join(ctx.outputDir, 'timed-subtitles'),
          args: { segments, format: 'srt' },
        })
        files.push(...subtitles.files)
      }
      return {
        summary: rhythm ? '已按真实音乐节拍重新剪辑并保留画面原声' : '已按镜头实际声音与指定转场完成合成',
        files,
        data: { ...native.data, timeline: true, duration: actual.duration },
      }
    }
    const result = await renderCreativeVideo({ ...timeline, projectId: ctx.projectId }, ctx.progress)
    ctx.signal.throwIfAborted()
    const files: ToolOutput['files'] = [await copied(ctx, result.videoUrl, 'video')]
    if (result.subtitleUrl) {
      const source = path.join(STORAGE_ROOT, result.subtitleUrl.replace(/^\/?static\//, '')),
        destination = path.join(ctx.outputDir, 'composed.srt')
      await fs.copyFile(source, destination)
      files.push({ path: destination, name: 'composed.srt', kind: 'subtitle' })
    }
    return {
      summary: '已按实际时间线完成画面、逐镜配音、原声、配乐及字幕合成',
      files,
      data: {
        duration: result.duration,
        width: result.width,
        height: result.height,
        warnings: result.warnings,
        timeline: true,
      },
    }
  }
  if (LOCAL_TOOL_IDS.includes(ctx.toolId))
    return runLocalTool({ ...ctx, progress: (value) => ctx.progress(value * 100) })
  if (auxiliaryIds.includes(ctx.toolId)) return runAuxiliaryTool(ctx)
  if (providerToolSpecs[ctx.toolId]) {
    const spec = providerToolSpecs[ctx.toolId]
    const preset = providerPresets[spec.serviceType]?.[spec.provider]
    const config =
      ctx.config ??
      (spec.requiresApiKey === false
        ? { provider: spec.provider, baseUrl: preset?.baseUrl || '', apiKey: '', model: spec.model }
        : undefined)
    return runProviderTool({
      ...ctx,
      args: { ...(ctx.config as any)?.serviceOptions, ...ctx.args },
      config: config
        ? { ...config, model: typeof ctx.args.model === 'string' ? ctx.args.model : spec.model }
        : undefined,
    })
  }
  const spec = sharedToolSpecs[ctx.toolId]
  if (!spec) throw new CreativeError('工具未配置执行路径', 503)
  if (spec.mode === 'piper') return runPiper(ctx)
  if (spec.mode === 'transcription') return runTranscription(ctx)
  if (spec.mode === 'lipsync') return runLip(ctx)
  if (spec.mode === 'image' || spec.mode === 'video') return runUnifiedGeneration(ctx, spec.mode)
  const selected = Object.entries(providerToolSpecs).find(
    ([, target]) => target.serviceType === spec.serviceType && target.provider === ctx.config?.provider,
  )
  if (!selected) throw new CreativeError('当前服务尚不支持此项能力，请选择工具库中对应的模型服务', 503)
  return runProviderTool({
    ...ctx,
    toolId: selected[0],
    args: { ...(ctx.config as any)?.serviceOptions, ...ctx.args },
  })
}
