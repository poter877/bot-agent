import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ffmpegPath, ffprobePath } from '../../utils/ffmpeg.js'
import fs from 'node:fs'
import path from 'node:path'
import { STORAGE_ROOT } from '../../utils/paths.js'
import { and, eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../../db/index.js'
import { CreativeError, creativeDocumentSchema } from '../creative-model.js'
import {
  approveCreativeProject,
  getCreativeProject,
  requireCreativeRevision,
  saveCreativeProject,
  withCreativeMutation,
} from '../creative-projects.js'
import { inspectCreativeSource } from '../creative-renderer.js'
import { applyToolboxOutput, publicToolboxJob, toolboxService } from '../production-tools/jobs.js'
import { PipelineInputRequired, type PipelineArtifact, type StageContext } from './contracts.js'
import { resolveToolBindings, subtitleWritebackText } from './tool-bindings.js'
import type {
  PipelineToolExecution,
  PipelineToolPhase,
  PipelineToolRuntime,
  PipelineToolStep,
} from './tool-contracts.js'

type ApplyingCheckpoint = {
  revision: number
  fileUrl: string
  target: NonNullable<PipelineToolStep['apply']>['target']
  shotId?: string
  sourceId?: string
  approval: boolean
  unchangedHash: string
  expectedDuration?: number
}
type RecoverableExecution = PipelineToolExecution & { applying?: ApplyingCheckpoint }
type ToolboxJob = ReturnType<typeof publicToolboxJob>
export const pipelineToolDependencies = {
  start: toolboxService.start,
  resume: toolboxService.resume,
  apply: applyToolboxOutput,
  project: getCreativeProject,
  recoverSubmitted(
    projectId: number,
    toolId: string,
    args: Record<string, unknown>,
    revision: number,
    configId?: number,
  ): ToolboxJob | null {
    // The durable row may exist even if the process stopped before its ID reached the stage checkpoint.
    const rows = db
      .select()
      .from(schema.productionToolJobs)
      .where(
        and(
          eq(schema.productionToolJobs.projectId, projectId),
          eq(schema.productionToolJobs.toolId, toolId),
          eq(schema.productionToolJobs.revision, revision),
        ),
      )
      .all()
    const found = rows.reverse().find((row) => {
      const input = JSON.parse(row.input)
      return (!configId || input.configId === configId) && JSON.stringify(input.args) === JSON.stringify(args)
    })
    return found ? publicToolboxJob(found) : null
  },
  read(projectId: number, id: number): ToolboxJob {
    getCreativeProject(projectId)
    const row = db
      .select()
      .from(schema.productionToolJobs)
      .where(and(eq(schema.productionToolJobs.id, id), eq(schema.productionToolJobs.projectId, projectId)))
      .get()
    if (!row) throw new PipelineInputRequired(`制作工具任务 #${id} 不存在，请检查任务记录`)
    return publicToolboxJob(row)
  },
}
export type PipelineToolDependencies = typeof pipelineToolDependencies
const isActive = (status: string) => ['queued', 'running', 'pending', 'processing'].includes(status)
const runtimeFrom = (artifact: PipelineArtifact | null | undefined): PipelineToolRuntime | undefined => {
  const value = artifact?.data?.toolRuntime as PipelineToolRuntime | undefined
  return value?.version === 1 && Array.isArray(value.steps) ? value : undefined
}
function previousSteps(context: StageContext) {
  return Object.values(context.artifacts).flatMap((artifact) => runtimeFrom(artifact)?.steps ?? [])
}
function restore(context: StageContext, planned: PipelineToolStep[]) {
  const runtime = structuredClone(runtimeFrom(context.previous) ?? { version: 1 as const, steps: [] })
  const keys = new Set<string>()
  for (const step of planned) {
    if (keys.has(step.key)) throw new PipelineInputRequired(`流程工具步骤编号重复：${step.key}`)
    keys.add(step.key)
    const existing = runtime.steps.find((item) => item.key === step.key)
    if (
      existing &&
      (existing.toolId !== step.toolId ||
        existing.configId !== step.configId ||
        existing.shotId !== step.shotId ||
        existing.sourceId !== step.sourceId ||
        JSON.stringify(existing.apply) !== JSON.stringify(step.apply))
    )
      throw new PipelineInputRequired('当前工具方案与已提交的任务不一致，请退回本阶段重新规划')
    if (!existing) runtime.steps.push({ ...structuredClone(step), status: 'pending' })
  }
  const graph = new Map([...previousSteps(context), ...runtime.steps].map((step) => [step.key, step]))
  const visiting = new Set<string>(),
    checked = new Set<string>()
  const check = (key: string) => {
    if (visiting.has(key)) throw new PipelineInputRequired('流程工具依赖存在循环，请检查制作方案')
    if (checked.has(key)) return
    const step = graph.get(key)
    if (!step) throw new PipelineInputRequired(`流程工具缺少前序步骤：${key}`)
    visiting.add(key)
    for (const dependency of step.dependsOn) {
      const parent = graph.get(dependency)
      if (parent && parent.stage === step.stage && parent.phase === 'after' && step.phase === 'before')
        throw new PipelineInputRequired('前置工具不能依赖本阶段尚未执行的后置工具')
      check(dependency)
    }
    visiting.delete(key)
    checked.add(key)
  }
  for (const step of runtime.steps) check(step.key)
  return runtime
}
function validateReport(step: PipelineToolExecution) {
  if (step.role !== 'analysis' && !/(?:validator|reviewer|visual_qa)$/.test(step.toolId)) return
  const data = step.data ?? {}
  if (
    data.passed === false ||
    data.valid === false ||
    (Array.isArray(data.errors) && data.errors.length) ||
    (Array.isArray(data.issues) && data.issues.length)
  )
    throw new PipelineInputRequired(
      `「${step.reason}」检查未通过，请查看已保存的质检报告并修正素材，流程不会继续交付`,
    )
}
function fileFor(step: PipelineToolExecution) {
  const file = step.files?.find((file) => !step.apply?.kind || file.kind === step.apply.kind)
  if (!file) throw new PipelineInputRequired(`「${step.reason}」未返回可回写的${step.apply?.kind ?? ''}文件`)
  return file
}
function alreadyApplied(project: ReturnType<typeof getCreativeProject>, step: PipelineToolExecution) {
  const apply = step.apply
  if (!apply || ['artifact', 'delivery'].includes(apply.target)) return true
  if (apply.target === 'model') return step.writeback === 'model'
  const file = fileFor(step)
  if (apply.target === 'music') return project.audio.musicUrl === file.url
  if (apply.target === 'narration') return project.audio.narrationUrl === file.url
  if (apply.target === 'source') return project.production.sources.some((source) => source.url === file.url)
  if (apply.target === 'render')
    return project.renders.some(
      (render) =>
        render.videoUrl === file.url || render.outputs.some((output) => output.videoUrl === file.url),
    )
  if (apply.target === 'transcript') {
    if (step.appliedRevision !== undefined) return true
    const source = project.production.sources.find(
      (source) => source.id === (apply.sourceId ?? step.sourceId),
    )
    if (!source?.transcript) return false
    if (file.kind === 'data' && typeof step.data?.text === 'string')
      return source.transcript === step.data.text.trim()
    try {
      if (!file.url.startsWith(`/static/creative/${project.id}/toolbox/${step.jobId}/`)) return false
      const filename = path.join(STORAGE_ROOT, file.url.slice('/static/'.length))
      if (fs.statSync(filename).size > 400000) return false
      return (
        source.transcript === subtitleWritebackText(fs.readFileSync(filename, 'utf8'), path.extname(filename))
      )
    } catch {
      return false
    }
  }
  const shot = project.shots.find((shot) => shot.id === (apply.shotId ?? step.shotId))
  if (
    (step as RecoverableExecution).applying?.expectedDuration !== undefined &&
    Math.abs((shot?.duration ?? 0) - (step as RecoverableExecution).applying!.expectedDuration!) > 1 / 1000
  )
    return false
  return file.kind === 'audio'
    ? shot?.audioUrl === file.url && shot.audioTrimStart === 0
    : file.kind === 'video'
      ? shot?.videoUrl === file.url && shot.trimStart === 0
      : shot?.imageUrl === file.url && shot.trimStart === 0
}
function mutationHash(
  project: ReturnType<typeof getCreativeProject>,
  checkpoint: Omit<ApplyingCheckpoint, 'unchangedHash'>,
) {
  const document = creativeDocumentSchema.parse(project)
  const file = checkpoint.fileUrl
  if (checkpoint.target === 'source')
    document.production.sources = document.production.sources.filter((source) => source.url !== file)
  if (checkpoint.target === 'music') document.audio.musicUrl = null
  if (checkpoint.target === 'narration') document.audio.narrationUrl = null
  if (checkpoint.target === 'transcript')
    document.production.sources = document.production.sources.map((source) =>
      source.id === checkpoint.sourceId ? { ...source, transcript: '' } : source,
    )
  if (checkpoint.target === 'shot')
    document.shots = document.shots.map((shot) => {
      if (shot.id !== checkpoint.shotId) return shot
      const value: Record<string, unknown> = { ...shot }
      if (checkpoint.expectedDuration !== undefined) delete value.duration
      const kind = /\.(?:mp3|wav|m4a|aac|ogg|flac)$/i.test(file)
        ? 'audio'
        : /\.(?:mp4|mov|webm|m4v)$/i.test(file)
          ? 'video'
          : 'image'
      for (const key of kind === 'audio'
        ? ['audioUrl', 'audioTrimStart']
        : [kind + 'Url', 'mediaType', 'trimStart'])
        delete value[key]
      return value as typeof shot
    })
  return createHash('sha256')
    .update(JSON.stringify({ title: project.title, ...document }))
    .digest('hex')
}
/** Recover only our exact single revision write, never unrelated project changes. */
export function reconcilePipelineToolRevision(
  projectId: number,
  expectedRevision: number,
  artifact: PipelineArtifact | null,
): number | null {
  const project = getCreativeProject(projectId)
  if (project.revision !== expectedRevision + 1) return null
  for (const item of runtimeFrom(artifact)?.steps ?? []) {
    const step = item as RecoverableExecution,
      applying = step.applying
    if (
      !applying ||
      applying.revision !== expectedRevision ||
      !step.jobId ||
      !step.files?.some((file) => file.url === applying.fileUrl)
    )
      continue
    if (mutationHash(project, applying) !== applying.unchangedHash || !alreadyApplied(project, step)) continue
    if (applying.approval && project.approvedRevision !== project.revision)
      approveCreativeProject(projectId, project.revision)
    step.appliedRevision = project.revision
    step.writeback = applying.target
    delete step.applying
    return project.revision
  }
  return null
}
async function fitShotVoice(context: StageContext, step: PipelineToolExecution) {
  const shotId = step.apply?.shotId ?? step.shotId
  const shot = getCreativeProject(context.project.id).shots.find((shot) => shot.id === shotId)
  if (!shot || !step.jobId) throw new PipelineInputRequired('配音拟合缺少目标镜头或制作任务')
  const raw = fileFor(step)
  const prefix = `/static/creative/${context.project.id}/toolbox/${step.jobId}/`
  if (raw.kind !== 'audio' || !raw.url.startsWith(prefix))
    throw new PipelineInputRequired('配音原始产物不属于当前任务')
  const root = await fs.promises.realpath(
    path.join(STORAGE_ROOT, 'creative', String(context.project.id), 'toolbox', String(step.jobId)),
  )
  const input = await fs.promises.realpath(path.join(STORAGE_ROOT, raw.url.slice('/static/'.length)))
  if (!input.startsWith(root + path.sep)) throw new PipelineInputRequired('配音素材不能越过当前任务目录')
  const info = await inspectCreativeSource(context.project.id, raw.url, false)
  if (info.kind !== 'audio' || !info.duration) throw new PipelineInputRequired('无法读取合成配音的真实时长')
  const speed = Math.max(1, info.duration / shot.duration)
  if (speed > 1.5 + 1e-6)
    throw new PipelineInputRequired(
      `镜头「${shot.title}」配音过长，需要超过1.5倍语速，请精简讲稿或增加镜头时长；原始音频与任务已保留，不会重新调用模型`,
    )
  if (!ffmpegPath) throw new PipelineInputRequired('FFmpeg不可用，无法将配音对齐镜头时长')
  const hash = createHash('sha256')
    .update(JSON.stringify([raw.url, shot.duration]))
    .digest('hex')
    .slice(0, 20)
  const filename = `voice-fitted-${hash}.wav`,
    output = path.join(root, filename),
    url = prefix + filename
  let valid = false
  try {
    const existing = await inspectCreativeSource(context.project.id, url, false)
    valid =
      existing.kind === 'audio' &&
      !!existing.duration &&
      Math.abs(existing.duration - shot.duration) <= 1 / 100
  } catch {
    /* The derived file is produced once and reused on recovery. */
  }
  if (!valid) {
    const temporary = path.join(root, `voice-fitting-${randomUUID()}.wav`)
    try {
      await promisify(execFile)(
        ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-y',
          '-protocol_whitelist',
          'file',
          '-format_whitelist',
          'wav,mp3,mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,aac,ogg,flac',
          '-i',
          input,
          '-vn',
          '-af',
          `atempo=${speed},apad`,
          '-t',
          String(shot.duration),
          '-ar',
          '48000',
          '-ac',
          '2',
          '-c:a',
          'pcm_s16le',
          temporary,
        ],
        { timeout: 180000, maxBuffer: 1024 * 1024, windowsHide: true },
      )
      await fs.promises.rename(temporary, output)
    } finally {
      await fs.promises.rm(temporary, { force: true })
    }
    const fitted = await inspectCreativeSource(context.project.id, url, false)
    if (fitted.kind !== 'audio' || !fitted.duration || Math.abs(fitted.duration - shot.duration) > 1 / 100)
      throw new PipelineInputRequired('配音对齐后的实际音频时长与镜头不符，已保留原始音频')
  }
  step.files = [
    { url, name: filename, kind: 'audio' },
    ...(step.files ?? []).filter((file) => file.url !== url),
  ]
  step.data = {
    ...step.data,
    rawAudioUrl: raw.url,
    fittedAudioUrl: url,
    speechFit: {
      sourceDuration: info.duration,
      targetDuration: shot.duration,
      speed,
      padded: info.duration < shot.duration,
    },
  }
}
const nativeAvatarTools = new Set(['heygen_avatar', 'heygen_video'])
async function nativeAvatarDuration(context: StageContext, step: PipelineToolExecution) {
  const file = fileFor(step)
  const info = await inspectCreativeSource(context.project.id, file.url, false)
  if (
    file.kind !== 'video' ||
    info.kind !== 'video' ||
    !info.duration ||
    info.duration < 1 / 30 ||
    info.duration > 600
  )
    throw new PipelineInputRequired('原生数字人服务未返回有效的视频时长')
  if (!ffprobePath) throw new PipelineInputRequired('FFprobe不可用，无法检查数字人视频的原生配音')
  const filename = path.join(STORAGE_ROOT, file.url.slice('/static/'.length))
  const { stdout } = await promisify(execFile)(
    ffprobePath,
    [
      '-v',
      'error',
      '-protocol_whitelist',
      'file',
      '-format_whitelist',
      'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'json',
      filename,
    ],
    { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true },
  )
  const metadata = JSON.parse(stdout) as { streams?: { codec_type?: string }[] }
  if (!metadata.streams?.some((stream) => stream.codec_type === 'audio'))
    throw new PipelineInputRequired('原生数字人视频没有实际音轨，无法提取讲稿配音；任务产物已保留')
  step.data = {
    ...step.data,
    nativeAvatar: true,
    appliedDuration: info.duration,
    requestedDuration: step.resolvedArgs?.duration ?? step.args.duration,
  }
  return info.duration
}
async function silenceWritebackDuration(context: StageContext, step: PipelineToolExecution) {
  const data = step.data ?? {},
    file = fileFor(step)
  const original = data.originalDuration,
    kept = data.keptDuration,
    ranges = data.ranges
  if (
    typeof original !== 'number' ||
    !Number.isFinite(original) ||
    original <= 0 ||
    typeof kept !== 'number' ||
    !Number.isFinite(kept) ||
    kept <= 0 ||
    !Array.isArray(ranges) ||
    !ranges.length ||
    ranges.length > 100
  )
    throw new PipelineInputRequired('静音裁切产物缺少真实保留区间与时长')
  let previous = 0,
    sum = 0
  for (const item of ranges) {
    const range = item as { start?: unknown; end?: unknown }
    if (
      !range ||
      typeof range.start !== 'number' ||
      typeof range.end !== 'number' ||
      !Number.isFinite(range.start) ||
      !Number.isFinite(range.end) ||
      range.start < previous ||
      range.end <= range.start ||
      range.end > original + 1 / 30
    )
      throw new PipelineInputRequired('静音裁切的保留区间无效或超出原片时长')
    previous = range.end
    sum += range.end - range.start
  }
  if (Math.abs(sum - kept) > 1 / 30) throw new PipelineInputRequired('静音裁切记录的保留时长与区间不符')
  const sourceUrl = step.resolvedArgs?.sourceUrl
  if (typeof sourceUrl !== 'string') throw new PipelineInputRequired('静音裁切缺少原始输入素材记录')
  const input = await inspectCreativeSource(context.project.id, sourceUrl, false)
  const output = await inspectCreativeSource(context.project.id, file.url, false)
  if (
    !input.duration ||
    Math.abs(input.duration - original) > 0.1 ||
    !output.duration ||
    !['audio', 'video'].includes(output.kind) ||
    output.kind !== file.kind ||
    Math.abs(output.duration - kept) > 0.15
  )
    throw new PipelineInputRequired('静音裁切产物与实际媒体时长不符，已保留产物供检查')
  return Math.min(output.duration, kept)
}
async function applyOutput(
  context: StageContext,
  step: PipelineToolExecution,
  revision: number,
  deps: PipelineToolDependencies,
) {
  const apply = step.apply
  if (!apply || ['artifact', 'delivery'].includes(apply.target)) {
    step.writeback = apply?.target ?? 'artifact'
    step.appliedRevision = revision
    return revision
  }
  let project = deps.project(context.project.id)
  if (project.revision !== revision)
    throw new PipelineInputRequired('工具执行期间项目被修改，请同步修改后继续，现有任务产物已保留')
  if (alreadyApplied(project, step)) {
    const file = fileFor(step)
    if (apply.target === 'render') {
      const render = project.renders.find(
        (render) =>
          render.videoUrl === file.url || render.outputs.some((output) => output.videoUrl === file.url),
      )!
      step.data = {
        ...step.data,
        renderId: render.id,
        outputs: render.outputs.length
          ? render.outputs
          : [
              {
                shotId: 'movie',
                title: project.title,
                videoUrl: render.videoUrl,
                subtitleUrl: render.subtitleUrl,
                duration: render.duration,
              },
            ],
      }
    }
    if (apply.target === 'transcript' && file.kind === 'data')
      step.data = {
        ...step.data,
        transcriptTiming: 'untimed',
        transcriptNote: '此服务只返回原稿文本，未提供字幕时码；后续剪辑不能据此虚构起止时间。',
      }
    step.writeback = apply.target
    step.appliedRevision = project.revision
    return project.revision
  }
  const file = fileFor(step)
  const preserveApproval = project.approvedRevision === revision
  if (apply.target === 'shot' && nativeAvatarTools.has(step.toolId)) {
    const duration = await nativeAvatarDuration(context, step),
      shotId = apply.shotId ?? step.shotId
    project = await withCreativeMutation(project.id, () => {
      const current = requireCreativeRevision(project.id, revision),
        shot = current.shots.find((shot) => shot.id === shotId)
      if (!shot) throw new PipelineInputRequired('原生数字人视频缺少目标镜头')
      if (shot.audioUrl || current.audio.narrationUrl)
        throw new PipelineInputRequired(
          '当前数字人镜头已有独立配音，请先确认音轨选择，原生视频产物已保留，流程不会覆盖现有配音',
        )
      return saveCreativeProject(current.id, {
        ...current,
        shots: current.shots.map((item) =>
          item.id === shotId
            ? { ...item, mediaType: 'video', videoUrl: file.url, duration, trimStart: 0 }
            : item,
        ),
      })
    })
  } else if (apply.target === 'shot' && step.role === 'voice') {
    const shotId = apply.shotId ?? step.shotId
    const info = await inspectCreativeSource(project.id, file.url, false)
    project = await withCreativeMutation(project.id, () => {
      const current = requireCreativeRevision(project.id, revision),
        shot = current.shots.find((shot) => shot.id === shotId)
      if (
        !shot ||
        file.kind !== 'audio' ||
        info.kind !== 'audio' ||
        !info.duration ||
        Math.abs(info.duration - shot.duration) > 1 / 100
      )
        throw new PipelineInputRequired('配音产物尚未按目标镜头实际时长对齐')
      return saveCreativeProject(current.id, {
        ...current,
        shots: current.shots.map((item) =>
          item.id === shotId ? { ...item, audioUrl: file.url, audioTrimStart: 0 } : item,
        ),
      })
    })
  } else if (apply.target === 'music' || apply.target === 'narration') {
    if (file.kind !== 'audio') throw new PipelineInputRequired('配乐与旁白工具未返回音频产物')
    project = await withCreativeMutation(project.id, () => {
      const current = requireCreativeRevision(project.id, revision)
      return saveCreativeProject(current.id, {
        ...current,
        audio: { ...current.audio, [apply.target === 'music' ? 'musicUrl' : 'narrationUrl']: file.url },
      })
    })
  } else if (apply.target === 'transcript' && file.kind === 'data') {
    const text = step.data?.text,
      sourceId = apply.sourceId ?? step.sourceId
    if (
      typeof text !== 'string' ||
      !text.trim() ||
      text.length > 60000 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)
    )
      throw new PipelineInputRequired('语音识别工具没有返回有效原稿文本')
    project = await withCreativeMutation(project.id, () => {
      const current = requireCreativeRevision(project.id, revision)
      if (!current.production.sources.some((source) => source.id === sourceId && source.kind !== 'image'))
        throw new PipelineInputRequired('原稿回写缺少正确的视频或音频来源')
      return saveCreativeProject(current.id, {
        ...current,
        production: {
          ...current.production,
          sources: current.production.sources.map((source) =>
            source.id === sourceId ? { ...source, transcript: text.trim() } : source,
          ),
        },
      })
    })
    step.data = {
      ...step.data,
      transcriptTiming: 'untimed',
      transcriptNote: '此服务只返回原稿文本，未提供字幕时码；后续剪辑不能据此虚构起止时间。',
    }
  } else if (
    apply.target === 'shot' &&
    step.toolId === 'silence_cutter' &&
    step.resolvedArgs?.operation !== 'detect'
  ) {
    const duration = await silenceWritebackDuration(context, step)
    project = await withCreativeMutation(project.id, () => {
      const current = requireCreativeRevision(project.id, revision),
        shotId = apply.shotId ?? step.shotId
      const shot = current.shots.find((shot) => shot.id === shotId)
      if (!shot) throw new PipelineInputRequired('静音裁切缺少目标镜头')
      if (
        current.audio.narrationUrl ||
        (file.kind === 'video' && shot.audioUrl) ||
        (file.kind === 'audio' && shot.mediaType === 'video')
      )
        throw new PipelineInputRequired(
          '静音裁切将改变原片时序，当前镜头有独立配音或视频，请先对齐音画后继续，已保留裁切产物',
        )
      const replacement =
        file.kind === 'video'
          ? { ...shot, duration, mediaType: 'video' as const, videoUrl: file.url, trimStart: 0 }
          : { ...shot, duration, audioUrl: file.url, audioTrimStart: 0 }
      return saveCreativeProject(current.id, {
        ...current,
        shots: current.shots.map((item) => (item.id === shotId ? replacement : item)),
      })
    })
    step.data = { ...step.data, appliedDuration: duration }
  } else if (apply.target === 'render') {
    if (file.kind !== 'video') throw new PipelineInputRequired('成片处理工具未返回视频产物')
    const info = await inspectCreativeSource(project.id, file.url, false)
    if (info.kind !== 'video' || !info.duration)
      throw new PipelineInputRequired('成片处理结果没有可解码的视频流')
    await withCreativeMutation(project.id, () => {
      const current = requireCreativeRevision(project.id, revision)
      const prior = current.renders.find(
        (render) =>
          render.videoUrl === file.url || render.outputs.some((output) => output.videoUrl === file.url),
      )
      const timestamp = new Date().toISOString()
      const subtitle = step.files?.find((item) => item.kind === 'subtitle')?.url ?? null
      const individual = !!(apply.shotId ?? step.shotId)
      const outputs = individual
        ? [
            {
              shotId: (apply.shotId ?? step.shotId)!,
              title: apply.name ?? current.title,
              videoUrl: file.url,
              subtitleUrl: subtitle,
              duration: info.duration!,
            },
          ]
        : []
      const renderId =
        prior?.id ??
        getInsertId(
          db
            .insert(schema.creativeRenders)
            .values({
              projectId: current.id,
              revision,
              snapshot: JSON.stringify({ toolJobId: step.jobId, toolStepKey: step.key, phase: step.phase }),
              status: 'completed',
              progress: 100,
              videoUrl: individual ? null : file.url,
              subtitleUrl: individual ? null : subtitle,
              duration: info.duration!,
              outputs: JSON.stringify(outputs),
              warnings: '[]',
              createdAt: timestamp,
              completedAt: timestamp,
            })
            .run(),
        )
      step.data = {
        ...step.data,
        renderId,
        outputs: individual
          ? outputs
          : [
              {
                shotId: 'movie',
                title: current.title,
                videoUrl: file.url,
                subtitleUrl: subtitle,
                duration: info.duration!,
              },
            ],
      }
    })
    project = deps.project(project.id)
  } else {
    if (!step.jobId) throw new PipelineInputRequired('工具任务编号缺失，不能回写产物')
    const shotId = apply.shotId ?? step.shotId
    const sourceId = apply.sourceId ?? step.sourceId
    if (apply.target === 'shot' && !shotId) throw new PipelineInputRequired('工具回写缺少目标镜头')
    if (apply.target === 'transcript' && !sourceId) throw new PipelineInputRequired('字幕回写缺少原始素材')
    project = await deps.apply(project.id, step.jobId, {
      revision,
      fileUrl: file.url,
      ...(apply.target === 'shot' ? { shotId } : {}),
      ...(apply.target === 'transcript' ? { sourceId } : {}),
      ...(apply.name ? { sourceName: apply.name } : {}),
    })
  }
  if (preserveApproval && project.revision !== revision && project.approvedRevision !== project.revision)
    project = approveCreativeProject(project.id, project.revision)
  step.appliedRevision = project.revision
  step.writeback = apply.target
  return project.revision
}
/** Execute a stage's real durable tool graph. A polling turn never starts a duplicate remote request. */
export async function runPipelineTools(
  context: StageContext,
  planned: PipelineToolStep[],
  phase: PipelineToolPhase,
  overrides: Partial<PipelineToolDependencies> = {},
): Promise<{ runtime: PipelineToolRuntime; waiting: boolean; revision: number }> {
  const deps = { ...pipelineToolDependencies, ...overrides }
  const runtime = restore(context, planned)
  let revision = context.project.revision
  const base = context.previous ?? {
    summary: '制作工具执行记录',
    content: '工具由当前制作流程自动串联，产物与任务编号已保留。',
    checks: [],
  }
  const persist = () =>
    context.checkpoint({ ...base, data: { ...base.data, toolRuntime: structuredClone(runtime) } }, revision)
  persist()
  const candidates = new Map(
    runtime.steps
      .filter((step) => step.stage === context.stage.id && step.phase === phase)
      .map((step) => [step.key, step]),
  )
  const activeSteps: PipelineToolExecution[] = [],
    ordered = new Set<string>()
  const order = (step: PipelineToolExecution) => {
    if (ordered.has(step.key)) return
    ordered.add(step.key)
    for (const key of step.dependsOn) {
      const dependency = candidates.get(key)
      if (dependency) order(dependency)
    }
    activeSteps.push(step)
  }
  for (const step of candidates.values()) order(step)
  const completed = () => [...previousSteps(context), ...runtime.steps]
  for (const step of activeSteps) {
    if (step.status === 'skipped') continue
    if (step.status === 'completed' && step.appliedRevision !== undefined) continue
    const dependencies = step.dependsOn.map((key) =>
      new Map(completed().map((candidate) => [candidate.key, candidate])).get(key),
    )
    if (dependencies.some((item) => !item || item.status !== 'completed')) {
      if (dependencies.some((item) => item && ['failed', 'uncertain'].includes(item.status))) {
        step.status = 'failed'
        step.error = '前序工具尚未恢复成功'
        persist()
        throw new PipelineInputRequired('前序工具需要处理，任务与产物已保留')
      }
      return { runtime, waiting: true, revision }
    }
    try {
      let job: ToolboxJob
      if (step.jobId) {
        job = deps.read(context.project.id, step.jobId)
      } else {
        const prepared = !!step.resolvedArgs
        step.resolvedArgs ??= resolveToolBindings(step.args, completed())
        persist()
        const recovered = prepared
          ? deps.recoverSubmitted(context.project.id, step.toolId, step.resolvedArgs, revision, step.configId)
          : null
        job =
          recovered ??
          (await deps.start(context.project.id, {
            revision,
            toolId: step.toolId,
            args: step.resolvedArgs,
            ...(step.configId ? { configId: step.configId } : {}),
          }))
        step.jobId = job.id
      }
      if (job.status === 'uncertain') {
        step.status = 'uncertain'
        step.error = job.error
        step.remoteId = job.remoteId
        persist()
        throw new PipelineInputRequired(
          `工具 #${job.id} 提交结果未知，请核对服务商任务编号后在任务记录中恢复。流程不会自动重复提交。`,
        )
      }
      if (['failed', 'cancelled'].includes(job.status)) {
        step.status = 'failed'
        step.error = job.error
        step.remoteId = job.remoteId
        persist()
        if (!context.retry)
          throw new PipelineInputRequired(
            `${job.error ?? '制作工具执行失败'}；任务 #${job.id} 已保留，请检查后重试`,
          )
        job = await deps.resume(context.project.id, job.id)
      }
      step.remoteId = job.remoteId
      step.progress = job.progress
      step.error = job.error
      if (isActive(job.status)) {
        step.status = 'running'
        persist()
        return { runtime, waiting: true, revision }
      }
      if (job.status !== 'completed') {
        step.status = job.status === 'uncertain' ? 'uncertain' : 'failed'
        persist()
        throw new PipelineInputRequired(`${job.error ?? '制作工具需要恢复'}；请检查任务 #${job.id}`)
      }
      step.files = structuredClone(job.result.files ?? [])
      step.data = structuredClone(job.result.data ?? {})
      step.status = 'completed'
      step.progress = 100
      step.error = null
      if (step.role === 'voice' && step.apply?.target === 'shot') {
        try {
          await fitShotVoice(context, step)
        } catch (error) {
          step.status = 'failed'
          throw error
        }
      }
      try {
        validateReport(step)
      } catch (error) {
        step.status = 'failed'
        throw error
      }
      // Save the result before touching the project. Re-entry checks actual URLs before any second write.
      persist()
      if (step.apply && !['artifact', 'delivery', 'model', 'render'].includes(step.apply.target)) {
        const current = deps.project(context.project.id)
        const applying = {
          revision,
          fileUrl: fileFor(step).url,
          target: step.apply.target,
          shotId: step.apply.shotId ?? step.shotId,
          sourceId: step.apply.sourceId ?? step.sourceId,
          approval: current.approvedRevision === revision,
        }
        const expectedDuration =
          step.apply.target === 'shot' && nativeAvatarTools.has(step.toolId)
            ? await nativeAvatarDuration(context, step)
            : step.toolId === 'silence_cutter' && step.apply.target === 'shot'
              ? await silenceWritebackDuration(context, step)
              : undefined
        ;(step as RecoverableExecution).applying = {
          ...applying,
          ...(expectedDuration !== undefined ? { expectedDuration } : {}),
          unchangedHash: mutationHash(current, {
            ...applying,
            ...(expectedDuration !== undefined ? { expectedDuration } : {}),
          }),
        }
        persist()
      }
      revision = await applyOutput(context, step, revision, deps)
      delete (step as RecoverableExecution).applying
      persist()
    } catch (error) {
      if (step.status !== 'uncertain' && !(step.status === 'completed' && step.files)) step.status = 'failed'
      step.error = error instanceof Error ? error.message.slice(0, 1000) : '制作工具执行失败'
      persist()
      if (error instanceof PipelineInputRequired) throw error
      if (error instanceof CreativeError) throw new PipelineInputRequired(error.message)
      throw new PipelineInputRequired(
        `「${step.reason}」执行失败，任务与产物已保留，请检查工具服务配置后重试`,
        { cause: error },
      )
    }
  }
  return { runtime, waiting: false, revision }
}
