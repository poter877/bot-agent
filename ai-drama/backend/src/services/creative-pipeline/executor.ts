import { executeExtensions, extensionTools } from './extensions.js'
import { withPipelineAutomation } from './automation.js'
import { planPipelineTools, parsePipelineAutomation } from './tool-planner.js'
import { runPipelineTools } from './tool-runtime.js'
import { db, schema } from '../../db/index.js'
import { and, eq } from 'drizzle-orm'
import type { PipelineToolRuntime } from './tool-contracts.js'
import { publicToolSettings } from '../creative-tools/settings.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getActiveConfig } from '../ai.js'
import { checkFfmpegSuite } from '../../utils/ffmpeg.js'
import { STORAGE_ROOT } from '../../utils/paths.js'
import { creativeDocumentSchema } from '../creative-model.js'
import { generateCreativeShot, startCreativeRender } from '../creative-production.js'
import {
  getCreativeProject,
  requireCreativeRevision,
  saveCreativeProject,
  validateCreativeMedia,
  withCreativeMutation,
} from '../creative-projects.js'
import { inspectCreativeSource } from '../creative-renderer.js'
import { getCreativeRecipe } from '../creative-catalog.js'
import { synthesizeCreativeShot, transcribeCreativeSource } from '../creative-speech.js'
import { parseCreativeSrt, sourceSelectionsToShots } from '../creative-sources.js'
import { generateStageNarrative, planPipelineScenes, translateCreativeCaptions } from './text.js'
import {
  PipelineInputRequired,
  type StageContext,
  type StageResult,
  type PipelineArtifact,
} from './contracts.js'

export const pipelineTools = {
  narrative: generateStageNarrative,
  plan: planPipelineScenes,
  translate: translateCreativeCaptions,
  generate: generateCreativeShot,
  render: startCreativeRender,
  transcribe: transcribeCreativeSource,
  speech: synthesizeCreativeShot,
  extensions: extensionTools,
  toolPlan: planPipelineTools,
  runTools: runPipelineTools,
}
export type PipelineTools = typeof pipelineTools
const active = (status?: string) => ['pending', 'queued', 'processing', 'running'].includes(status ?? '')
const artifact = (
  summary: string,
  content: string,
  data: Record<string, unknown> = {},
  checks: string[] = [],
): PipelineArtifact => ({ summary, content, data, checks })
async function legacyExtensions(context: StageContext, tools: PipelineTools['extensions']) {
  const automation = parsePipelineAutomation(context.project)
  const fields = { ...context.project.production.fields }
  if (automation.researchTool !== undefined) fields.researchMode = ''
  if (automation.stockTool !== undefined) fields.stockMode = ''
  if (automation.speechTool !== undefined) fields.speechMode = ''
  const avatarTool = automation.avatarTool ?? automation.videoTool
  if (automation.avatarTool !== undefined) fields.lipSyncMode = ''
  if (
    context.stage.id === 'rig_plan' &&
    fields.rigMode === 'meshy' &&
    automation.modelTool &&
    automation.modelTool !== 'off'
  ) {
    const runtime = context.artifacts.character_design?.data?.toolRuntime as PipelineToolRuntime | undefined
    const generated = runtime?.steps.find(
      (step) => step.apply?.target === 'model' && step.status === 'completed' && step.jobId,
    )
    if (generated?.jobId) {
      const job = db
        .select()
        .from(schema.productionToolJobs)
        .where(
          and(
            eq(schema.productionToolJobs.id, generated.jobId),
            eq(schema.productionToolJobs.projectId, context.project.id),
          ),
        )
        .get()
      const modelId = job ? JSON.parse(job.state).importedModelId : undefined
      if (
        typeof modelId === 'number' &&
        db
          .select()
          .from(schema.creativeModels)
          .where(
            and(
              eq(schema.creativeModels.id, modelId),
              eq(schema.creativeModels.projectId, context.project.id),
            ),
          )
          .get()
      )
        fields.rigModelId = String(modelId)
    }
  }
  if (
    avatarTool &&
    ['kling_avatar', 'kling_lip_sync', 'lip_sync', 'talking_head', 'heygen_avatar'].includes(avatarTool)
  )
    fields.lipSyncMode = ''
  const extensionContext = {
    ...context,
    project: { ...context.project, production: { ...context.project.production, fields } },
  }
  const result = await executeExtensions(extensionContext, tools)
  context.artifacts = extensionContext.artifacts
  return result
}

export async function pipelineCapabilities(projectId: number) {
  const project = getCreativeProject(projectId)
  const [text, image, video, ffmpeg, speech, transcription] = await Promise.all([
    getActiveConfig('text'),
    getActiveConfig('image'),
    getActiveConfig('video'),
    checkFfmpegSuite(),
    getActiveConfig('speech'),
    getActiveConfig('transcription'),
  ])
  const providers = publicToolSettings()
  return [
    {
      id: 'text',
      title: '脚本、规划和翻译',
      available: !!text?.model,
      detail: text?.model ? '使用已启用的文本模型' : '请在模型设置中启用文本模型',
    },
    {
      id: 'image',
      title: '图片制作',
      available: !!image?.model,
      detail: image?.model ? '使用已启用的图片模型' : '可配置图片模型，或直接导入图片',
    },
    {
      id: 'video',
      title: '视频制作',
      available: !!video?.model,
      detail: video?.model ? '使用已启用的视频模型' : '可配置视频模型，或直接导入视频',
    },
    {
      id: 'compose',
      title: '剪辑、混音与字幕合成',
      available: ffmpeg.ffmpeg && ffmpeg.ffprobe,
      detail: ffmpeg.ffmpeg && ffmpeg.ffprobe ? '本地视频处理可用' : '需要可用的 FFmpeg 与 FFprobe',
    },
    {
      id: 'transcript',
      title: '原稿与时码',
      available:
        !!transcription?.apiKey ||
        project.production.sources.some((s) => s.transcript.trim()) ||
        project.shots.some((s) => s.caption.trim()),
      detail: '支持原稿、SRT 和 OpenAI 语音识别；自动识别需在制作要求中开启',
    },
    {
      id: 'voice',
      title: '旁白与配音',
      available: !!speech?.apiKey || !!project.audio.narrationUrl || project.shots.some((s) => !!s.audioUrl),
      detail: '支持原声、上传配音和 OpenAI 合成语音；自动配音需在制作要求中开启',
    },
    ...providers.map((p) => ({
      id: p.provider,
      title: {
        sync: '数字人口型同步',
        meshy: '三维骨骼绑定',
        tavily: '联网资料检索',
        pexels: '联网素材取材',
      }[p.provider],
      available: p.enabled && p.configured,
      detail: p.enabled && p.configured ? '已配置，可在制作工具中启用' : '请在模型与服务中配置并启用',
    })),
  ]
}

export function createStageExecutor(tools: PipelineTools = pipelineTools) {
  const execute = async (context: StageContext): Promise<StageResult> => {
    const { definition, stage, artifacts, previous } = context
    let project = requireCreativeRevision(context.project.id, context.project.revision)
    const id = project.id
    if (stage.id === 'rig_plan') {
      const extension = await legacyExtensions(context, tools.extensions)
      if (extension) return extension
    }
    if (stage.id === 'idea' || stage.id === 'research') {
      if (!project.brief.idea.trim())
        throw new PipelineInputRequired('请在创作需求中填写并保存主题，然后同步修改继续。')
      const recipe = getCreativeRecipe(project.category)
      if (
        recipe.source !== 'optional' &&
        !project.production.sources.some((s) =>
          recipe.source === 'video' ? s.kind === 'video' : s.kind !== 'image',
        )
      )
        throw new PipelineInputRequired('此流程需要原片，请先在原始素材区上传视频或音频，再同步修改。')
      const extension = await legacyExtensions(context, tools.extensions)
      if (extension) return extension
      const source = project.production.sources.find((s) => s.kind !== 'image' && !s.transcript.trim())
      if (source && project.production.fields.transcriptionMode === 'openai') {
        const saved = await tools.transcribe(id, project.revision, source.id)
        return {
          waiting: true,
          revision: saved.revision,
          artifact: artifact(
            `已识别「${source.name}」的原声`,
            '逐字稿与真实时码已保存，可在创作需求中检查。',
            { sourceId: source.id },
          ),
        }
      }
    }
    if (stage.id === 'script' && definition.category === 'localization') {
      if (
        !project.shots.length &&
        project.production.fields.transcriptionMode === 'openai' &&
        project.production.sources.length === 1
      ) {
        const source = project.production.sources[0]
        const shots = sourceSelectionsToShots(project, source.id, parseCreativeSrt(source.transcript), true)
        const saved = await withCreativeMutation(id, () => saveCreativeProject(id, { ...project, shots }))
        return {
          waiting: true,
          revision: saved.revision,
          artifact: artifact('原片字幕时序已建立', '保留原片空白段和每条字幕时码，接下来生成译稿。', {
            shots: saved.shots,
          }),
        }
      }
      if (!project.shots.length || !project.shots.some((s) => s.caption.trim() || s.narration.trim()))
        throw new PipelineInputRequired('请先上传原片并按 SRT 时码编排，或填写带时序的字幕，再同步修改。')
      const translated = await tools.translate(project)
      if (project.production.fields.speechMode === 'openai')
        translated.shots = translated.shots.map((s) => ({ ...s, narration: s.narration || s.caption }))
      return {
        artifact: artifact(
          '字幕译稿已生成，时序保持不变',
          translated.shots.map((s) => `${s.title}\n${s.caption}\n${s.narration}`).join('\n\n'),
          { translatedShots: translated.shots },
          ['核对术语与原稿含义', '检查目标语言和每段阅读长度'],
        ),
      }
    }
    if (['research', 'idea', 'proposal', 'script', 'character_design', 'rig_plan'].includes(stage.id)) {
      const sourceOnly = ['talking_head', 'screen_demo', 'podcast', 'clip_factory'].includes(project.category)
      if (
        stage.id === 'script' &&
        sourceOnly &&
        !project.production.sources.some((s) => s.transcript.trim()) &&
        !project.plan.script.trim()
      )
        throw new PipelineInputRequired('请补充原片逐字稿、操作说明或带时码的原稿，流程不会编造转录。')
      const narrative = await tools.narrative(context)
      return {
        artifact: { ...narrative, data: { articles: context.artifacts.web_research?.data?.articles } },
      }
    }
    if (stage.id === 'scene_plan') {
      const translated = artifacts.script?.data?.translatedShots
      const planned =
        definition.category === 'localization' && Array.isArray(translated)
          ? creativeDocumentSchema.parse({ ...project, shots: translated })
          : await tools.plan(context)
      const saved = await withCreativeMutation(id, () =>
        saveCreativeProject(id, { ...planned, revision: project.revision }),
      )
      return {
        revision: saved.revision,
        artifact: artifact(
          `已编排 ${saved.shots.length} 个镜头`,
          saved.shots
            .map((s, i) => `${i + 1}. ${s.title} · ${s.duration} 秒\n${s.visualPrompt}\n字幕：${s.caption}`)
            .join('\n\n'),
          { shots: saved.shots },
          ['在画面编排中核对镜头、字幕、来源和总时长', '确认后才开始生成缺失素材'],
        ),
      }
    }
    if (stage.id === 'assets') {
      if (!project.shots.length) throw new PipelineInputRequired('请先完成分镜编排')
      const recipe = getCreativeRecipe(project.category)
      if (project.approvedRevision !== project.revision)
        throw new PipelineInputRequired('请确认当前分镜方案后继续')
      const extension = await legacyExtensions(context, tools.extensions)
      if (extension) return extension
      const pending: string[] = [],
        missing: string[] = []
      for (const shot of project.shots) {
        const url = shot.mediaType === 'image' ? shot.imageUrl : shot.videoUrl
        if (url) {
          validateCreativeMedia(id, url, shot.mediaType)
          continue
        }
        const task = shot.mediaType === 'image' ? shot.imageTask : shot.videoTask
        if (active(task?.status)) {
          pending.push(shot.id)
          continue
        }
        if (task?.status === 'failed' && !context.retry)
          throw new Error(`镜头「${shot.title}」生成失败；检查模型后点击重试，可保留已经完成的素材。`)
        const automation = parsePipelineAutomation(project)
        if ((shot.mediaType === 'image' ? automation.imageTool : automation.videoTool) === 'off') {
          missing.push(`${shot.title}（已关闭自动${shot.mediaType === 'image' ? '图片' : '视频'}制作）`)
          continue
        }
        if (recipe.source !== 'optional' || project.category === 'avatar') {
          missing.push(shot.title)
          continue
        }
        if (shot.mediaType === 'video' && shot.duration > 15) {
          missing.push(`${shot.title}（生成镜头需拆到15秒以内）`)
          continue
        }
        const updated = await tools.generate(id, shot.id, {
          revision: project.revision,
          kind: shot.mediaType,
        })
        pending.push(shot.id)
        context.checkpoint(
          artifact('素材正在制作', '已提交镜头任务，继续时复用任务记录，不重复生成。', {
            tasks: updated.shots
              .filter((s) => s.imageTaskId || s.videoTaskId)
              .map((s) => ({ shotId: s.id, imageTaskId: s.imageTaskId, videoTaskId: s.videoTaskId })),
          }),
        )
      }
      if (missing.length) throw new PipelineInputRequired(`请导入这些镜头的原始素材：${missing.join('、')}`)
      project = getCreativeProject(id)
      const manifest = project.shots.map((s) => ({
        shotId: s.id,
        title: s.title,
        mediaType: s.mediaType,
        url: s.mediaType === 'image' ? s.imageUrl : s.videoUrl,
        audioUrl: s.audioUrl,
        imageTaskId: s.imageTaskId,
        videoTaskId: s.videoTaskId,
      }))
      if (pending.length)
        return {
          waiting: true,
          artifact: artifact(
            `等待 ${pending.length} 个素材任务`,
            '任务进度会自动刷新。暂停流程不会取消已经提交的生成任务。',
            { manifest },
          ),
        }
      const speech = project.shots.find((s) => s.narration.trim() && !s.audioUrl)
      if (
        speech &&
        !project.audio.narrationUrl &&
        project.production.fields.speechMode === 'openai' &&
        parsePipelineAutomation(project).speechTool === undefined
      ) {
        const saved = await tools.speech(id, project.revision, speech.id)
        return {
          waiting: true,
          revision: saved.revision,
          artifact: artifact(
            `已生成「${speech.title}」的配音`,
            '合成语音已按镜头时长对齐；全部完成后请试听确认。',
            { manifest: saved.shots.map((s) => ({ shotId: s.id, audioUrl: s.audioUrl })) },
          ),
        }
      }
      const missingVoice = project.shots.some(
        (s) =>
          s.narration.trim() &&
          !s.audioUrl &&
          !(s.mediaType === 'video' && recipe.source !== 'optional' && project.category !== 'localization'),
      )
      if (missingVoice && !project.audio.narrationUrl)
        throw new PipelineInputRequired(
          '方案包含旁白，但没有可用旁白音轨。请开启自动配音、上传配音，或移除不需要的旁白文字后同步修改；生成的视频不能自动视为已经含有准确旁白。',
        )
      return {
        artifact: artifact(
          '素材已就绪',
          manifest.map((m) => `${m.title} · ${m.mediaType} · ${m.url}`).join('\n'),
          { manifest },
          ['检查人物与画面连续性', '确认原片来源和音频内容'],
        ),
      }
    }
    if (stage.id === 'edit') {
      const cache = new Map<string, Awaited<ReturnType<typeof inspectCreativeSource>>>()
      const probe = async (url: string) => {
        if (!cache.has(url)) cache.set(url, await inspectCreativeSource(id, url, false))
        return cache.get(url)!
      }
      let offset = 0
      const timeline = []
      for (const shot of project.shots) {
        const url = shot.mediaType === 'image' ? shot.imageUrl : shot.videoUrl
        if (!url) throw new PipelineInputRequired(`镜头「${shot.title}」缺少素材`)
        validateCreativeMedia(id, url, shot.mediaType)
        const info = await probe(url)
        if (info.kind !== shot.mediaType)
          throw new PipelineInputRequired(`镜头「${shot.title}」的素材类型不匹配`)
        if (info.duration != null && shot.trimStart + shot.duration > info.duration + 1 / 30)
          throw new PipelineInputRequired(`镜头「${shot.title}」选段超过原片时长`)
        if (shot.audioUrl) {
          validateCreativeMedia(id, shot.audioUrl, 'audio')
          const audio = await probe(shot.audioUrl)
          if (audio.duration == null || shot.audioTrimStart + shot.duration > audio.duration + 1 / 30)
            throw new PipelineInputRequired(`镜头「${shot.title}」音频选段超出时长`)
        }
        timeline.push({
          id: shot.id,
          title: shot.title,
          start: offset,
          end: offset + shot.duration,
          trimStart: shot.trimStart,
          caption: shot.caption,
          originalVolume: shot.originalVolume,
        })
        offset += shot.duration
      }
      if (!timeline.length) throw new PipelineInputRequired('没有可以剪辑的镜头')
      if (definition.delivery === 'clips' && project.audio.narrationUrl)
        throw new PipelineInputRequired('批量切片不能混入整片配音，请移除整片配音并使用片段原声')
      return {
        artifact: artifact(
          `时间线检查通过，共 ${offset.toFixed(2)} 秒`,
          timeline
            .map(
              (s) => `${s.title}：${s.start.toFixed(2)}–${s.end.toFixed(2)} 秒，原片起点 ${s.trimStart} 秒`,
            )
            .join('\n'),
          { timeline, audio: project.audio, delivery: definition.delivery },
          ['试听原声与配音音量', '核对每条字幕与切点'],
        ),
      }
    }
    if (stage.id === 'compose') {
      const toolRuntime = artifacts.tool_results?.data?.toolRuntime as PipelineToolRuntime | undefined
      const composed = toolRuntime?.steps.filter(
        (step) =>
          step.status === 'completed' && step.apply?.target === 'render' && Array.isArray(step.data?.outputs),
      )
      if (composed?.length) {
        const outputs = composed.flatMap((step) => step.data!.outputs as unknown[])
        return {
          artifact: artifact(
            `已通过制作工具合成 ${outputs.length} 个视频`,
            '真实画面、音轨与字幕已经合成并保存到项目成片。',
            { renderId: composed.at(-1)?.data?.renderId, outputs },
            ['预览检查字幕与声音同步'],
          ),
        }
      }
      const jobId = previous?.data?.renderId
      let job = typeof jobId === 'number' ? project.renders.find((r) => r.id === jobId) : undefined
      if (job?.revision !== project.revision) job = undefined
      if (job?.status === 'failed' && !context.retry) throw new Error(job.errorMsg || '视频合成失败，请重试')
      if (!job || (job.status === 'failed' && context.retry)) {
        const updated = await tools.render(id, {
          revision: project.revision,
          individual: definition.delivery === 'clips',
        })
        job = updated.renders[0]
        if (!job) throw new Error('合成任务未创建')
        context.checkpoint(
          artifact('合成任务已提交', '保留该任务记录，继续时不重复提交。', { renderId: job.id }),
        )
      }
      if (active(job.status))
        return {
          waiting: true,
          artifact: artifact(`正在合成 ${job.progress}%`, '等待本地合成与文件校验。', { renderId: job.id }),
        }
      if (job.status !== 'completed') throw new Error(job.errorMsg || '合成任务未完成')
      const outputs = job.outputs.length
        ? job.outputs
        : [
            {
              shotId: 'movie',
              title: project.title,
              videoUrl: job.videoUrl,
              subtitleUrl: job.subtitleUrl,
              duration: job.duration,
            },
          ]
      return {
        artifact: artifact(
          `已完成 ${outputs.length} 个视频`,
          '请在成片导出页预览画面、字幕与声音，确认后继续交付。',
          { renderId: job.id, outputs, warnings: job.warnings },
          ['实际预览成片', '检查字幕可读性与声音同步'],
        ),
      }
    }
    if (stage.id === 'publish') {
      const outputs = artifacts.compose?.data?.outputs
      if (!Array.isArray(outputs) || !outputs.length) throw new Error('没有已确认的成片')
      const metadata = {
        title: project.title,
        description: project.plan.summary,
        pipeline: definition.id,
        version: definition.version,
        revision: project.revision,
        language: project.brief.language,
        aspectRatio: project.aspectRatio,
        outputs,
        chapters: artifacts.edit?.data?.timeline,
        rigFiles: artifacts.rig_plan?.data?.files,
        research: artifacts.research?.data?.articles ?? artifacts.idea?.data?.articles,
        sources: project.production.sources.map(({ name, attribution }) => ({ name, attribution })),
      }
      const root = await fs.realpath(STORAGE_ROOT)
      const folder = path.join(root, 'creative', String(id))
      await fs.mkdir(folder, { recursive: true })
      const real = await fs.realpath(folder)
      if (!real.startsWith(root + path.sep)) throw new Error('交付目录超出素材目录')
      const filename = `delivery-${randomUUID()}.json`
      await fs.writeFile(path.join(real, filename), JSON.stringify(metadata, null, 2), 'utf8')
      return {
        artifact: artifact('交付清单已生成', '成片、字幕、章节和来源说明已整理；尚未发布到任何外部平台。', {
          ...metadata,
          manifestUrl: `/static/creative/${id}/${filename}`,
        }),
      }
    }
    throw new Error(`未实现的执行阶段：${stage.id}`)
  }
  return withPipelineAutomation(execute, tools)
}
