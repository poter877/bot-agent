import { z } from 'zod'
import { createHash } from 'node:crypto'
import { db, schema } from '../../db/index.js'
import { rankConfigs } from '../ai-registry.js'
import type { CreativeProject } from '../creative-projects.js'
import type { ToolFileKind } from '../production-tools/contracts.js'
import { localToolFields } from '../production-tools/local.js'
import { acquisitionDomains } from '../production-tools/auxiliary.js'
import { providerToolSpecs } from '../production-tools/providers.js'
import { PipelineInputRequired, type PipelineArtifact, type StageContext } from './contracts.js'
import { getPipelineToolPolicy } from './tool-policy.js'
import type { PipelineToolPhase, PipelineToolReference, PipelineToolStep } from './tool-contracts.js'

const parameters = z.record(z.string(), z.record(z.string(), z.unknown()))
export const pipelineAutomationSchema = z
  .object({
    visual: z
      .enum(['auto', 'generated', 'diagram', 'math', 'character', 'threejs', 'blender', 'source'])
      .default('auto'),
    analysis: z.enum(['auto', 'off', 'vision']).default('auto'),
    stockTool: z.string().max(100).optional(),
    researchTool: z.string().max(100).optional(),
    musicTool: z.string().max(100).optional(),
    speechTool: z.string().max(100).optional(),
    imageTool: z.string().max(100).optional(),
    videoTool: z.string().max(100).optional(),
    avatarTool: z.string().max(100).optional(),
    modelTool: z.string().max(100).optional(),
    transcriptionTool: z.string().max(100).optional(),
    postTools: z.array(z.string().max(100)).max(30).default([]),
    toolParameters: parameters.default({}),
    capture: z.boolean().default(false),
  })
  .strict()
export type PipelineAutomation = z.infer<typeof pipelineAutomationSchema>
export function parsePipelineAutomation(project: Pick<CreativeProject, 'production'>): PipelineAutomation {
  const value = project.production.fields.automation
  if (!value?.trim()) return pipelineAutomationSchema.parse({})
  try {
    return pipelineAutomationSchema.parse(JSON.parse(value))
  } catch {
    throw new PipelineInputRequired('自动制作设置格式不正确，请检查制作要求中的自动化设置后保存。')
  }
}
type Arguments = Record<string, unknown>
type Shot = CreativeProject['shots'][number]
type ToolPlan = { toolId: string; args?: Arguments; reason?: string; chain?: ToolPlan[] }
const object = (value: unknown): Arguments =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Arguments) : {}
const meaningful = (value: unknown) =>
  value != null && value !== '' && (!Array.isArray(value) || value.length > 0)
const ref = (key: string, kind?: ToolFileKind, dataPath?: string): PipelineToolReference => ({
  $step: key,
  ...(kind ? { kind } : {}),
  ...(dataPath !== undefined ? { dataPath } : {}),
})
const sourcePages = new Set([...Object.keys(acquisitionDomains), 'direct_clip_search'])
const stockTools = new Set([
  'archive_org',
  'loc',
  'nasa',
  'pexels',
  'pexels_image',
  'pexels_video',
  'pixabay_image',
  'pixabay_video',
  'wikimedia',
  'unsplash',
  'freesound_music',
])
const lips = new Set(['kling_avatar', 'kling_lip_sync', 'lip_sync', 'talking_head'])
const composers = new Set(['video_compose', 'hyperframes_compose', 'video_stitch', 'bgm_montage_lite'])
const selectionSettings: Record<string, keyof PipelineAutomation> = {
  image: 'imageTool',
  video: 'videoTool',
  speech: 'speechTool',
  transcription: 'transcriptionTool',
  music: 'musicTool',
  stock: 'stockTool',
  research: 'researchTool',
  model3d: 'modelTool',
  avatar: 'avatarTool',
}
const size = (project: CreativeProject) =>
  project.aspectRatio === '9:16'
    ? { width: 720, height: 1280 }
    : project.aspectRatio === '1:1'
      ? { width: 960, height: 960 }
      : { width: 1280, height: 720 }
const media = (shot: Shot) => (shot.mediaType === 'image' ? shot.imageUrl : shot.videoUrl)
const sourceFor = (project: CreativeProject, shot: Shot) =>
  project.production.sources.find((source) => source.url === media(shot) || source.url === shot.audioUrl)
function outputFiles(artifact?: PipelineArtifact) {
  const values = artifact?.data?.outputs
  return Array.isArray(values) ? values.map(object) : []
}

/** Select only tools required by the accepted scene, never every provider advertising the same capability. */
export function planPipelineTools(context: StageContext, phase: PipelineToolPhase): PipelineToolStep[] {
  const { project, stage } = context
  const automation = parsePipelineAutomation(project)
  const steps: PipelineToolStep[] = []
  const selected = (key: keyof PipelineAutomation) => {
    const value = automation[key]
    return typeof value === 'string' && value !== 'off' ? value : undefined
  }
  const params = (toolId: string) => automation.toolParameters[toolId] ?? {}
  const sourceFingerprint = createHash('sha256')
    .update(
      JSON.stringify(
        project.production.sources.map(({ id, url, transcript, duration, attribution }) => ({
          id,
          url,
          transcript,
          duration,
          attribution,
        })),
      ),
    )
    .digest('hex')
  const existingModelUrls = Object.values(context.artifacts)
    .flatMap((artifact) => {
      const direct = Array.isArray(artifact.data?.files) ? artifact.data.files : []
      const runtime = object(artifact.data?.toolRuntime)
      const executions = Array.isArray(runtime.steps) ? runtime.steps : []
      return [
        ...direct,
        ...executions.flatMap((execution) => {
          const files = object(execution).files
          return Array.isArray(files) ? files : []
        }),
      ]
    })
    .map((file) => object(file).url)
    .filter((url): url is string => typeof url === 'string' && /^\/static\/[\w/-]+\.glb$/i.test(url))
  function allowed(toolId: string, explicit: boolean) {
    const policy = getPipelineToolPolicy(toolId)
    if (!policy) throw new PipelineInputRequired(`自动制作选择了未知工具「${toolId}」，请重新选择。`)
    if (!policy.categories.includes(project.category)) {
      if (explicit)
        throw new PipelineInputRequired(`「${toolId}」不适合当前「${context.definition.title}」流程。`)
      return false
    }
    return true
  }
  function validateArgs(toolId: string, args: Arguments) {
    const schema = localToolFields[toolId]
    const required = schema && Array.isArray(schema.required) ? (schema.required as string[]) : []
    for (const key of required)
      if (!meaningful(args[key]))
        throw new PipelineInputRequired(`「${toolId}」缺少 ${key}，请补充分镜工具参数或自动制作设置。`)
    if (['diagram_gen'].includes(toolId) && !meaningful(args.boxes) && !meaningful(args.definition))
      throw new PipelineInputRequired('图解镜头需要节点列表或真实图表定义，请补充分镜工具参数。')
    if (
      ['subtitle_gen', 'remotion_caption_burn'].includes(toolId) &&
      !meaningful(args.segments) &&
      !meaningful(args.subtitleUrl)
    )
      throw new PipelineInputRequired('字幕工具需要真实字幕时码或已批准的逐镜头字幕。')
    if (lips.has(toolId) && !args.shotId) throw new PipelineInputRequired('口型同步需要绑定实际人物镜头。')
    const service = providerToolSpecs[toolId]?.serviceType
    if (
      ['image', 'video', 'model3d'].includes(service) &&
      !meaningful(args.prompt) &&
      !meaningful(args.sourceUrl) &&
      !meaningful(args.image_url)
    )
      throw new PipelineInputRequired(`「${toolId}」需要明确的制作描述或参考素材。`)
    if (service === 'speech' && !meaningful(args.text))
      throw new PipelineInputRequired('配音工具需要已批准的讲稿。')
  }
  function add(
    key: string,
    toolId: string,
    args: Arguments,
    options: Partial<PipelineToolStep> = {},
    explicit = false,
  ): PipelineToolStep | undefined {
    if (!allowed(toolId, explicit)) return
    const policy = getPipelineToolPolicy(toolId)!
    const setting = policy.selectionKey ? selectionSettings[policy.selectionKey] : undefined
    if (setting && automation[setting] === 'off')
      throw new PipelineInputRequired(
        `自动制作已关闭 ${String(setting)}，请导入实际产物或重新开启对应服务后继续。`,
      )
    if (
      ['screen_recorder', 'screen_capture_selector'].includes(toolId) &&
      args.operation !== 'recommend' &&
      !automation.capture
    )
      throw new PipelineInputRequired(
        '实际录屏需要在自动制作设置中明确开启，分镜中的录屏建议不会直接访问桌面。',
      )
    if (steps.some((step) => step.key === key)) return steps.find((step) => step.key === key)
    const finalArgs = { ...params(toolId), ...args }
    if (options.shotId && ['image', 'video'].includes(policy.selectionKey ?? '')) {
      const shot = project.shots.find((item) => item.id === options.shotId)
      if (shot) finalArgs.prompt = shot.visualPrompt
    }
    validateArgs(toolId, finalArgs)
    const dependencies = new Set(options.dependsOn ?? [])
    function collect(value: unknown) {
      if (value && typeof value === 'object') {
        if ('$step' in value && typeof value.$step === 'string') dependencies.add(value.$step)
        else Object.values(value).forEach(collect)
      }
    }
    collect(finalArgs)
    const step: PipelineToolStep = {
      key,
      toolId,
      stage: stage.id,
      phase,
      role: policy.role,
      reason: policy.purpose,
      args: finalArgs,
      dependsOn: [...dependencies],
      ...options,
    }
    step.dependsOn = [...dependencies]
    steps.push(step)
    return step
  }
  function requireSelection(toolId: string, selection: string) {
    const policy = getPipelineToolPolicy(toolId)
    if (!policy || policy.selectionKey !== selection)
      throw new PipelineInputRequired(`「${toolId}」不能作为${selection}服务，请选择对应能力的工具。`)
    allowed(toolId, true)
  }
  function assetStep(
    key: string,
    toolId: string,
    args: Arguments,
    shot: Shot,
    kind?: ToolFileKind,
    explicit = false,
  ) {
    return add(
      key,
      toolId,
      args,
      {
        shotId: shot.id,
        apply: { target: kind === 'model' ? 'model' : 'shot', shotId: shot.id, ...(kind ? { kind } : {}) },
      },
      explicit,
    )
  }
  function common(shot?: Shot): Arguments {
    return {
      ...(shot
        ? {
            prompt: shot.visualPrompt,
            text: shot.narration || shot.caption,
            duration: shot.duration,
            duration_seconds: shot.duration,
            shotId: shot.id,
            ...(media(shot) ? { sourceUrl: media(shot) } : {}),
          }
        : { prompt: project.brief.idea }),
      ...size(project),
      aspect_ratio: project.aspectRatio,
    }
  }
  function searchAndImport(toolId: string, key: string, query: string, shot?: Shot, asMusic = false) {
    allowed(toolId, true)
    if (sourcePages.has(toolId)) {
      add(`${key}-search`, toolId, { ...params(toolId), query }, { apply: { target: 'artifact' } }, true)
      return
    }
    if (!stockTools.has(toolId)) throw new PipelineInputRequired(`「${toolId}」不是可下载的素材源。`)
    const custom = params(toolId),
      index = Number.isInteger(custom.index) && Number(custom.index) >= 0 ? Number(custom.index) : 0
    const queryArgs = { ...custom, query, download: false }
    const search = add(`${key}-search`, toolId, queryArgs, { apply: { target: 'artifact' } }, true)!
    const kind: ToolFileKind | undefined = asMusic ? 'audio' : shot?.mediaType
    add(
      `${key}-download`,
      toolId,
      { ...queryArgs, download: true, index, selected_id: ref(search.key, undefined, `items.${index}.id`) },
      {
        dependsOn: [search.key],
        ...(shot ? { shotId: shot.id } : {}),
        apply: {
          target: asMusic ? 'music' : shot ? 'shot' : 'source',
          ...(kind ? { kind } : {}),
          ...(shot ? { shotId: shot.id } : {}),
          name: query.slice(0, 160),
        },
      },
      true,
    )
  }
  function characterChain(shot: Shot, supplied: Arguments) {
    const base = `shot-${shot.id}-character`
    const characters =
      supplied.characters ??
      object(supplied.rig_plan).characters ??
      params('character_spec_generator').characters
    const actions =
      supplied.actions ??
      object(supplied.action_timeline).actions ??
      object(supplied.scene_plan).actions ??
      params('action_timeline_compiler').actions
    if (!Array.isArray(characters) || !characters.length || !Array.isArray(actions) || !actions.length)
      throw new PipelineInputRequired(
        `「${shot.title}」需要角色列表与动作时间轴，请在分镜工具参数中补充 characters 和 actions；流程不会编造角色或表演。`,
      )
    const design = add(
      `${base}-spec`,
      'character_spec_generator',
      { characters, brief: project.production.fields.characters || shot.visualPrompt },
      { shotId: shot.id, apply: { target: 'artifact' } },
    )!
    const rig = add(
      `${base}-rig`,
      'svg_rig_builder',
      { character_design: ref(design.key, undefined, '') },
      { shotId: shot.id, apply: { target: 'artifact' } },
    )!
    const poses = add(
      `${base}-poses`,
      'pose_library_builder',
      { rig_plan: ref(rig.key, undefined, '') },
      { shotId: shot.id, apply: { target: 'artifact' } },
    )!
    const timeline = add(
      `${base}-timeline`,
      'action_timeline_compiler',
      { scene_plan: { actions }, fps: 24 },
      { shotId: shot.id, dependsOn: [poses.key], apply: { target: 'artifact' } },
    )!
    const review = add(
      `${base}-review`,
      'character_animation_reviewer',
      {
        rig_plan: ref(rig.key, undefined, ''),
        action_timeline: ref(timeline.key, undefined, ''),
        review_level: 'static',
      },
      { shotId: shot.id, apply: { target: 'artifact' } },
    )!
    return add(
      `${base}-render`,
      'character_rig_renderer',
      {
        ...supplied,
        rig_plan: ref(rig.key, undefined, ''),
        action_timeline: ref(timeline.key, undefined, ''),
        duration_seconds: shot.duration,
        fps: 24,
        ...size(project),
      },
      { dependsOn: [review.key], shotId: shot.id, apply: { target: 'shot', shotId: shot.id, kind: 'video' } },
    )!
  }
  function avatarScene(shot: Shot, toolId: string, plan?: ToolPlan) {
    requireSelection(toolId, 'avatar')
    const configured = db
      .select()
      .from(schema.aiServiceConfigs)
      .all()
      .filter(
        (config) =>
          config.isActive &&
          config.provider === 'heygen' &&
          config.serviceType === providerToolSpecs[toolId]?.serviceType,
      )
      .sort(rankConfigs)[0]
    let serviceOptions: Arguments = {}
    try {
      serviceOptions = object(object(JSON.parse(configured?.settings || '{}')).serviceOptions)
    } catch {
      /* A malformed setting is rejected again by the provider. */
    }
    const supplied = { ...serviceOptions, ...params(toolId), ...object(plan?.args) }
    const voiceId = supplied.voice_id ?? supplied.voice
    const avatarId = supplied.avatar_id
    let portrait: unknown = supplied.image ?? supplied.image_url ?? supplied.portrait ?? shot.imageUrl
    let portraitStep: PipelineToolStep | undefined
    const imageTool = selected('imageTool')
    const makePortrait = () => {
      if (!imageTool)
        throw new PipelineInputRequired(
          `「${shot.title}」需要已绑定的人物画面、portrait或数字人ID；也可明确选择图片模型生成肖像。`,
        )
      requireSelection(imageTool, 'image')
      portraitStep = assetStep(
        `shot-${shot.id}-avatar-portrait`,
        imageTool,
        { ...params(imageTool), ...common(shot), prompt: shot.visualPrompt },
        shot,
        'image',
        true,
      )
      portrait = ref(portraitStep!.key, 'image')
    }
    if (!lips.has(toolId)) {
      const currentRuntime = object(context.previous?.data?.toolRuntime)
      const resumedNative =
        Array.isArray(currentRuntime.steps) &&
        currentRuntime.steps.some((value) => {
          const step = object(value)
          return (
            step.key === `shot-${shot.id}-avatar` && step.toolId === toolId && step.status === 'completed'
          )
        })
      if ((shot.audioUrl || project.audio.narrationUrl) && !resumedNative)
        throw new PipelineInputRequired(
          'HeyGen当前使用script与voice_id合成口播；已有独立配音请改选Sync，避免重新合成或覆盖已批准声音。',
        )
      if (!shot.narration.trim()) throw new PipelineInputRequired(`「${shot.title}」需要批准的数字人讲稿。`)
      if (!voiceId)
        throw new PipelineInputRequired('HeyGen需要真实voice_id，请在统一服务设置或工具参数中填写。')
      if (!portrait && !avatarId) makePortrait()
      const avatar = add(
        `shot-${shot.id}-avatar`,
        toolId,
        {
          ...supplied,
          text: shot.narration,
          script: shot.narration,
          ...(portrait ? { image_url: portrait } : { avatar_id: avatarId }),
          voice_id: voiceId,
          aspect_ratio: project.aspectRatio,
          duration: shot.duration,
        },
        {
          shotId: shot.id,
          ...(configured ? { configId: configured.id } : {}),
          ...(portraitStep ? { dependsOn: [portraitStep.key] } : {}),
          reason: '使用数字人服务的原生讲稿与音色生成口播，保留实际出声',
          apply: { target: 'shot', shotId: shot.id, kind: 'video' },
        },
        true,
      )
      return add(
        `shot-${shot.id}-avatar-native-audio`,
        'audio_mixer',
        {
          sourceUrl: ref(avatar!.key, 'video'),
          sourceUrls: [ref(avatar!.key, 'video')],
          operation: 'extract_audio',
          sample_rate: 48000,
          channels: 2,
        },
        {
          role: 'voice',
          shotId: shot.id,
          dependsOn: [avatar!.key],
          reason: '从数字人真实成片提取原生语音并按实际镜头时长拟合，避免重复调用语音模型',
          apply: { target: 'shot', shotId: shot.id, kind: 'audio' },
        },
        true,
      )
    }
    let speech: PipelineToolStep | undefined
    if (!shot.audioUrl) {
      const speechTool =
        selected('speechTool') ??
        (automation.speechTool !== 'off' && project.production.fields.speechMode === 'openai'
          ? 'tts_selector'
          : undefined)
      if (!speechTool || !shot.narration.trim())
        throw new PipelineInputRequired(
          `「${shot.title}」的Sync口型需要逐镜头真实配音，请上传或明确开启配音模型。`,
        )
      requireSelection(speechTool, 'speech')
      speech = assetStep(
        `shot-${shot.id}-speech`,
        speechTool,
        { ...common(shot), ...params(speechTool), text: shot.narration, language: project.brief.language },
        shot,
        'audio',
        true,
      )
    }
    if (!shot.videoUrl && !shot.imageUrl) {
      if (portrait) {
        portraitStep = assetStep(
          `shot-${shot.id}-avatar-portrait-input`,
          'upscale',
          { sourceUrl: portrait, scale: 1 },
          shot,
          'image',
          true,
        )
        if (portraitStep) portraitStep.reason = '规范化并绑定用户提供的真实人物肖像'
      } else makePortrait()
    }
    return add(
      `shot-${shot.id}-avatar`,
      toolId,
      { ...supplied, shotId: shot.id },
      {
        shotId: shot.id,
        dependsOn: [speech?.key, portraitStep?.key].filter((key): key is string => !!key),
        reason: '在真实配音拟合及人物画面就绪后同步该镜头口型',
        apply: { target: 'shot', shotId: shot.id, kind: 'video' },
      },
      true,
    )
  }
  function sceneTool(shot: Shot, plan: ToolPlan) {
    const policy = getPipelineToolPolicy(plan.toolId)
    if (!policy) throw new PipelineInputRequired(`分镜「${shot.title}」选择了未知工具「${plan.toolId}」。`)
    allowed(plan.toolId, true)
    if (policy.selectionKey === 'avatar') return avatarScene(shot, plan.toolId, plan)
    const supplied = { ...params(plan.toolId), ...object(plan.args) }
    if (plan.toolId === 'character_rig_renderer') return characterChain(shot, supplied)
    const service = providerToolSpecs[plan.toolId]?.serviceType
    if (stockTools.has(plan.toolId) || sourcePages.has(plan.toolId)) {
      searchAndImport(
        plan.toolId,
        `shot-${shot.id}-${plan.toolId}`,
        String(supplied.query || shot.visualPrompt || project.brief.idea),
        shot,
      )
      return
    }
    const args = { ...common(shot), ...supplied }
    if (['threejs_world', 'blender_world'].includes(plan.toolId)) {
      args.render_video = true
      if (!meaningful(args.model_urls)) {
        if (existingModelUrls.length) args.model_urls = [...new Set(existingModelUrls)]
        else if (steps.some((step) => step.key === 'project-model'))
          args.model_urls = [ref('project-model', 'model')]
      }
      if (!meaningful(args.world_spec) && meaningful(args.model_urls)) args.world_spec = { objects: [] }
    }
    let kind: ToolFileKind | undefined =
      service === 'speech' || service === 'music'
        ? 'audio'
        : service === 'model3d'
          ? 'model'
          : service === 'image'
            ? 'image'
            : service === 'video' || ['math_animate', 'threejs_world', 'blender_world'].includes(plan.toolId)
              ? 'video'
              : ['diagram_gen', 'code_snippet'].includes(plan.toolId)
                ? 'image'
                : plan.toolId === 'showcase_card'
                  ? supplied.render_video
                    ? 'video'
                    : 'image'
                  : undefined
    let target: NonNullable<PipelineToolStep['apply']>['target'] =
      service === 'music'
        ? 'music'
        : service === 'model3d'
          ? 'model'
          : ['analysis', 'research', 'model', 'interactive'].includes(policy.role)
            ? 'artifact'
            : 'shot'
    if (service === 'speech') {
      target = 'shot'
      kind = 'audio'
    }
    if (lips.has(plan.toolId)) {
      target = 'shot'
      kind = 'video'
    }
    if (['threejs_world', 'blender_world'].includes(plan.toolId)) target = 'shot'
    if (plan.toolId === 'subtitle_gen' || plan.toolId === 'music_library') target = 'artifact'
    if (plan.toolId === 'export_bundle') target = 'delivery'
    if (['screen_recorder', 'screen_capture_selector'].includes(plan.toolId)) {
      if (!automation.capture)
        throw new PipelineInputRequired(
          '实际录屏需要在自动制作设置中明确开启，分镜中的录屏建议不会直接访问桌面。',
        )
      target = 'source'
      kind = 'video'
    }
    const first = add(
      `shot-${shot.id}-${plan.toolId}`,
      plan.toolId,
      args,
      {
        shotId: shot.id,
        ...(plan.reason ? { reason: plan.reason } : {}),
        apply: { target, shotId: shot.id, ...(kind ? { kind } : {}) },
      },
      true,
    )
    let previous = first
    let lastMedia = target === 'shot' ? first : undefined
    let mediaKind = kind
    for (const [index, chained] of (plan.chain ?? []).entries()) {
      if (!previous) break
      const nextPolicy = getPipelineToolPolicy(chained.toolId)
      if (!nextPolicy) throw new PipelineInputRequired(`分镜处理链包含未知工具「${chained.toolId}」。`)
      const nextArgs = {
        ...params(chained.toolId),
        ...common(shot),
        sourceUrl: ref((lastMedia ?? previous).key, mediaKind),
        ...object(chained.args),
      }
      previous = add(
        `shot-${shot.id}-${plan.toolId}-chain-${index}-${chained.toolId}`,
        chained.toolId,
        nextArgs,
        {
          shotId: shot.id,
          dependsOn: [previous.key],
          ...(chained.reason ? { reason: chained.reason } : {}),
          apply: {
            target: nextPolicy.role === 'analysis' || nextPolicy.role === 'research' ? 'artifact' : 'shot',
            shotId: shot.id,
          },
        },
        true,
      )
      if (previous?.apply?.target === 'shot') {
        lastMedia = previous
        const service = providerToolSpecs[chained.toolId]?.serviceType
        if (['audio_enhance', 'audio_mixer'].includes(chained.toolId) || service === 'speech')
          mediaKind = 'audio'
        else if (
          service === 'image' ||
          ['diagram_gen', 'code_snippet', 'showcase_card'].includes(chained.toolId)
        )
          mediaKind = 'image'
        else if (
          service === 'video' ||
          ['math_animate', 'blender_world', 'threejs_world'].includes(chained.toolId)
        )
          mediaKind = 'video'
      }
    }
    return previous
  }

  if (phase === 'before' && ['research', 'idea'].includes(stage.id)) {
    const research = selected('researchTool')
    if (research) {
      const policy = getPipelineToolPolicy(research)
      if (!policy || !['research', 'analysis'].includes(policy.role))
        throw new PipelineInputRequired('资料研究需要选择来源检索或原片分析工具。')
      const args = {
        query: project.production.fields.researchQuery || project.brief.idea,
        ...params(research),
      }
      if (['video_downloader', 'transcript_fetcher'].includes(research) && !meaningful(object(args).url))
        throw new PipelineInputRequired('网页获取需要用户明确提供原片网址，请填写对应工具的 url。')
      const target =
        research === 'video_downloader'
          ? 'source'
          : research === 'transcript_fetcher'
            ? 'transcript'
            : 'artifact'
      add(
        `research-${research}`,
        research,
        args,
        {
          apply: {
            target,
            ...(params(research).sourceId ? { sourceId: String(params(research).sourceId) } : {}),
          },
        },
        true,
      )
    }
    const stock = selected('stockTool')
    if (stock) {
      requireSelection(stock, 'stock')
      searchAndImport(stock, 'research-stock', project.production.fields.stockQuery || project.brief.idea)
    }
    if (automation.capture) {
      if (project.category !== 'screen_demo')
        throw new PipelineInputRequired('屏幕录制仅适用于软件演示流程。')
      const tool =
        typeof params('screen_capture_selector').toolId === 'string'
          ? String(params('screen_capture_selector').toolId)
          : 'screen_recorder'
      if (!['screen_recorder', 'screen_capture_selector'].includes(tool))
        throw new PipelineInputRequired('实际录屏请选择屏幕录制工具，环境检查不能冒充录制结果。')
      add(
        'capture-environment',
        'cap_recorder',
        { operation: 'status' },
        { apply: { target: 'artifact' } },
        true,
      )
      add(
        'capture-recording',
        tool,
        { ...params(tool), operation: 'record' },
        {
          dependsOn: ['capture-environment'],
          apply: { target: 'source', kind: 'video', name: '实际屏幕录制' },
        },
        true,
      )
    }
    if (automation.analysis !== 'off') {
      for (const source of project.production.sources) {
        if (source.kind === 'video') {
          add(
            `source-${source.id}-analyze`,
            'video_analyzer',
            { sourceUrl: source.url, max_keyframes: 8 },
            { sourceId: source.id, apply: { target: 'artifact' } },
          )
          if (automation.analysis === 'vision')
            add(
              `source-${source.id}-understand`,
              'video_understand',
              { sourceUrl: source.url, prompt: project.brief.idea },
              { sourceId: source.id, apply: { target: 'artifact' } },
              true,
            )
        } else if (source.kind === 'audio') {
          add(
            `source-${source.id}-probe`,
            'audio_probe',
            { sourceUrl: source.url },
            { sourceId: source.id, apply: { target: 'artifact' } },
          )
          if (['podcast', 'talking_head', 'clip_factory'].includes(project.category))
            add(
              `source-${source.id}-energy`,
              'audio_energy',
              { sourceUrl: source.url, video_duration_seconds: project.brief.targetDuration },
              { sourceId: source.id, apply: { target: 'artifact' } },
            )
        }
        const transcriber = selected('transcriptionTool')
        if (transcriber && source.kind !== 'image' && !source.transcript.trim()) {
          requireSelection(transcriber, 'transcription')
          let audio: unknown = source.url
          if (transcriber !== 'transcriber') {
            const extract = add(
              `source-${source.id}-transcription-audio`,
              'audio_mixer',
              { sourceUrls: [source.url], operation: 'extract_audio', sample_rate: 16000, channels: 1 },
              { sourceId: source.id, apply: { target: 'artifact' } },
            )!
            audio = ref(extract.key, 'audio')
          }
          add(
            `source-${source.id}-transcribe`,
            transcriber,
            { ...params(transcriber), sourceUrl: source.url, audio_url: audio },
            {
              sourceId: source.id,
              apply: {
                target: 'transcript',
                sourceId: source.id,
                kind: transcriber === 'dashscope_asr' ? 'data' : 'subtitle',
              },
            },
            true,
          )
        }
      }
      if (project.production.sources.length)
        add(
          'project-corpus',
          'corpus_builder',
          { query: project.brief.idea, sourceFingerprint },
          { apply: { target: 'artifact' } },
        )
    }
  }
  if (
    phase === 'before' &&
    ['script', 'scene_plan'].includes(stage.id) &&
    automation.analysis !== 'off' &&
    project.production.sources.some((source) => source.transcript.trim())
  ) {
    add(
      'project-clip-search',
      'clip_search',
      {
        query:
          project.production.fields.selection || project.production.fields.highlights || project.brief.idea,
        sourceFingerprint,
      },
      { apply: { target: 'artifact' } },
    )
  }
  const modelStage = context.definition.stages.some((item) => item.id === 'character_design')
    ? 'character_design'
    : context.definition.stages.some((item) => item.id === 'rig_plan')
      ? 'rig_plan'
      : 'assets'
  if (stage.id === modelStage && phase === 'before') {
    const modelTool = selected('modelTool')
    if (modelTool && !existingModelUrls.length) {
      requireSelection(modelTool, 'model3d')
      add(
        'project-model',
        modelTool,
        { prompt: project.production.fields.characters || project.brief.idea, ...params(modelTool) },
        { apply: { target: 'model', kind: 'model' } },
        true,
      )
    }
  }
  if (stage.id === 'assets' && phase === 'before') {
    const musicTool = selected('musicTool')
    if (musicTool && !project.audio.musicUrl) {
      requireSelection(musicTool, 'music')
      const direction = project.plan.musicDirection || project.brief.tone
      if (!direction.trim()) throw new PipelineInputRequired('请先填写音乐方向，再启用自动配乐。')
      if (stockTools.has(musicTool) || sourcePages.has(musicTool))
        searchAndImport(musicTool, 'project-music', direction, undefined, true)
      else
        add(
          'project-music-generate',
          musicTool,
          {
            prompt: direction,
            duration: project.brief.targetDuration,
            duration_seconds: project.brief.targetDuration,
            ...params(musicTool),
          },
          { apply: { target: 'music', kind: 'audio' } },
          true,
        )
    }
    if (project.audio.musicUrl)
      add(
        'project-music-probe',
        'music_library',
        { sourceUrls: [project.audio.musicUrl] },
        { apply: { target: 'artifact' } },
      )
    for (const shot of project.shots) {
      const plan = object((shot as Shot & { toolPlan?: ToolPlan }).toolPlan) as ToolPlan
      const avatarTool = selected('avatarTool')
      if (avatarTool && (!plan.toolId || getPipelineToolPolicy(plan.toolId)?.selectionKey === 'avatar')) {
        avatarScene(shot, avatarTool, plan.toolId === avatarTool ? plan : undefined)
        continue
      }
      if (!media(shot)) {
        if (plan.toolId) sceneTool(shot, plan)
        else if (automation.visual === 'source')
          throw new PipelineInputRequired(`「${shot.title}」需要真实原片，请导入来源并绑定该镜头。`)
        else if (
          automation.visual === 'character' ||
          (automation.visual === 'auto' && project.category === 'character_animation')
        )
          characterChain(shot, { ...params('character_rig_renderer') })
        else if (automation.visual === 'math')
          sceneTool(shot, { toolId: 'math_animate', args: params('math_animate') })
        else if (['threejs', 'blender'].includes(automation.visual))
          sceneTool(shot, {
            toolId: automation.visual === 'threejs' ? 'threejs_world' : 'blender_world',
            args: params(automation.visual === 'threejs' ? 'threejs_world' : 'blender_world'),
          })
        else if (
          automation.visual === 'diagram' ||
          (automation.visual === 'auto' && project.category === 'explainer')
        ) {
          const supplied = params('diagram_gen')
          const labels = (shot.caption || shot.narration || shot.title)
            .split(/[。！？\n]/u)
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(0, 12)
          sceneTool(shot, {
            toolId: 'diagram_gen',
            args: {
              title: shot.title,
              boxes: labels.map((label) => ({ label: label.slice(0, 100) })),
              ...supplied,
            },
          })
        } else if (project.category === 'podcast' && shot.audioUrl)
          sceneTool(shot, {
            toolId: 'showcase_card',
            args: {
              title: shot.title,
              subtitle: (shot.caption || shot.narration).slice(0, 180),
              render_video: false,
            },
          })
        else {
          const imageTool = selected('imageTool'),
            videoTool = selected('videoTool')
          const toolId = shot.mediaType === 'image' ? imageTool : videoTool
          if (toolId) {
            requireSelection(toolId, shot.mediaType)
            assetStep(
              `shot-${shot.id}-selected-visual`,
              toolId,
              { ...common(shot), ...params(toolId) },
              shot,
              shot.mediaType,
              true,
            )
          }
        }
      }
      const speechTool = selected('speechTool')
      if (speechTool && !shot.audioUrl && !project.audio.narrationUrl && shot.narration.trim()) {
        requireSelection(speechTool, 'speech')
        assetStep(
          `shot-${shot.id}-speech`,
          speechTool,
          { ...common(shot), ...params(speechTool), text: shot.narration, language: project.brief.language },
          shot,
          'audio',
          true,
        )
      }
    }
  }
  if (stage.id === 'assets' && phase === 'after') {
    for (const shot of project.shots) {
      let previous: PipelineToolStep | undefined
      let lastVisual: PipelineToolStep | undefined
      let lastAudio: PipelineToolStep | undefined
      let tracker: PipelineToolStep | undefined
      let cutStep: PipelineToolStep | undefined
      for (const [index, toolId] of automation.postTools.entries()) {
        if (composers.has(toolId) || toolId === 'remotion_caption_burn') continue
        const policy = getPipelineToolPolicy(toolId)
        if (!policy || !['post', 'analysis', 'model', 'visual'].includes(policy.role))
          throw new PipelineInputRequired(`「${toolId}」不是可用于镜头的后处理工具。`)
        allowed(toolId, true)
        const supplied = params(toolId)
        const audioTool = toolId === 'audio_enhance' || toolId === 'audio_mixer'
        const lastMedia = audioTool ? lastAudio : lastVisual
        const sourceUrl = lastMedia
          ? ref(lastMedia.key, audioTool ? 'audio' : undefined)
          : audioTool
            ? shot.audioUrl
            : media(shot)
        if (!sourceUrl && !meaningful(supplied.sourceUrl) && !meaningful(supplied.sourceUrls)) continue
        const args: Arguments = { ...common(shot), sourceUrl, ...supplied }
        if (toolId === 'audio_mixer' && !args.sourceUrls)
          args.sourceUrls = [shot.audioUrl || sourceUrl].filter(Boolean)
        if (toolId === 'auto_reframe') {
          args.aspect_ratio = project.aspectRatio
          if (tracker) {
            args.tracking = ref(tracker.key, undefined, '')
            args.mode = 'face'
          }
          if (!args.mode) args.mode = project.category === 'screen_demo' ? 'pad' : 'center'
        }
        if (toolId === 'silence_cutter') {
          args.operation ??= 'detect'
          if (args.operation === 'cut') {
            if (shot.audioUrl || project.audio.narrationUrl)
              throw new PipelineInputRequired(
                '删静音会改变音画时序；当前镜头有独立配音，请先明确移除或重新对齐该音轨后继续。',
              )
            const trim = add(
              `shot-${shot.id}-silence-input-range`,
              'video_trimmer',
              {
                sourceUrl,
                operation: 'cut',
                start_seconds: shot.trimStart,
                end_seconds: shot.trimStart + shot.duration,
              },
              {
                shotId: shot.id,
                ...(previous ? { dependsOn: [previous.key] } : {}),
                apply: { target: 'artifact' },
              },
            )!
            args.sourceUrl = ref(trim.key, 'video')
            args.pipeline_trimmed = true
          }
        }
        previous = add(
          `shot-${shot.id}-post-${index}-${toolId}`,
          toolId,
          args,
          {
            shotId: shot.id,
            ...(previous ? { dependsOn: [previous.key] } : {}),
            apply: {
              target:
                policy.role === 'analysis' || (toolId === 'silence_cutter' && args.operation !== 'cut')
                  ? 'artifact'
                  : 'shot',
              shotId: shot.id,
              ...(toolId === 'audio_enhance' || toolId === 'audio_mixer' ? { kind: 'audio' } : {}),
            },
          },
          true,
        )
        if (toolId === 'silence_cutter' && args.operation === 'cut') cutStep = previous
        if (toolId === 'face_tracker') tracker = previous
        if (previous?.apply?.target === 'shot') {
          if (audioTool) lastAudio = previous
          else lastVisual = previous
        }
      }
      if (media(shot) && shot.mediaType === 'video')
        add(
          `shot-${shot.id}-asset-qa`,
          'visual_qa',
          {
            sourceUrl: lastVisual ? ref(lastVisual.key) : media(shot),
            operation: 'probe',
            ...(cutStep ? {} : { expected: { min_duration: shot.trimStart + shot.duration - 1 / 30 } }),
          },
          { shotId: shot.id, apply: { target: 'artifact' } },
        )
    }
  }
  if (stage.id === 'edit' && phase === 'before') {
    const clips: Arguments[] = []
    for (const shot of project.shots) {
      let sourceUrl: unknown = media(shot)
      if (!sourceUrl) continue
      const source = sourceFor(project, shot)
      if (
        shot.mediaType === 'video' &&
        source &&
        (shot.trimStart > 0 || (source.duration != null && shot.duration + 1 / 30 < source.duration))
      ) {
        const trim = add(
          `shot-${shot.id}-trim`,
          'video_trimmer',
          {
            sourceUrl,
            start_seconds: shot.trimStart,
            end_seconds: shot.trimStart + shot.duration,
            operation: 'cut',
          },
          { shotId: shot.id, sourceId: source.id, apply: { target: 'shot', shotId: shot.id, kind: 'video' } },
        )
        if (trim) sourceUrl = ref(trim.key, 'video')
      }
      if (
        shot.mediaType === 'video' &&
        ['clip_factory', 'talking_head', 'podcast', 'screen_demo'].includes(project.category) &&
        !automation.postTools.includes('auto_reframe')
      ) {
        const frame = add(
          `shot-${shot.id}-reframe`,
          'auto_reframe',
          {
            sourceUrl,
            aspect_ratio: project.aspectRatio,
            mode: project.category === 'screen_demo' ? 'pad' : 'center',
          },
          { shotId: shot.id, apply: { target: 'shot', shotId: shot.id, kind: 'video' } },
        )
        if (frame) sourceUrl = ref(frame.key, 'video')
      }
      clips.push({ sourceUrl, duration: shot.duration })
    }
    if (clips.length)
      add('project-composition-check', 'composition_validator', { clips }, { apply: { target: 'artifact' } })
    let offset = 0
    const segments = project.shots.flatMap((shot) => {
      const start = offset
      offset += shot.duration
      return shot.caption.trim() ? [{ start, end: offset, text: shot.caption }] : []
    })
    if (segments.length)
      add(
        'project-subtitles',
        'subtitle_gen',
        { segments, format: 'srt' },
        { apply: { target: 'artifact', kind: 'subtitle', name: '成片字幕' } },
      )
  }
  if (stage.id === 'compose' && phase === 'before') {
    const choices = automation.postTools.filter((toolId) => composers.has(toolId))
    if (choices.length > 1)
      throw new PipelineInputRequired('请只选择一个成片合成器，避免对同一时间线重复渲染。')
    const toolId = choices[0]
    if (toolId) {
      allowed(toolId, true)
      const groups =
        context.definition.delivery === 'clips' ? project.shots.map((shot) => [shot]) : [project.shots]
      for (const [index, shots] of groups.entries()) {
        if (!shots.length || shots.some((shot) => !media(shot)))
          throw new PipelineInputRequired('合成工具需要所有镜头的真实画面，请先完成素材阶段。')
        const timeline = {
          projectId: project.id,
          aspectRatio: project.aspectRatio,
          title: project.title,
          shots: shots.map(
            ({
              id,
              title,
              duration,
              mediaType,
              imageUrl,
              videoUrl,
              caption,
              trimStart,
              audioUrl,
              audioTrimStart,
              originalVolume,
            }) => ({
              id,
              title,
              duration,
              mediaType,
              imageUrl,
              videoUrl,
              caption,
              trimStart,
              audioUrl,
              audioTrimStart,
              originalVolume,
            }),
          ),
          narrationUrl: project.audio.narrationUrl,
          musicUrl: project.audio.musicUrl,
          musicVolume: project.audio.musicVolume,
          burnSubtitles:
            project.audio.burnSubtitles && !automation.postTools.includes('remotion_caption_burn'),
        }
        if (toolId === 'bgm_montage_lite' && !project.audio.musicUrl)
          throw new PipelineInputRequired('音乐混剪需要实际配乐音轨，请先导入或生成音乐。')
        add(
          `composition-${index}-${toolId}`,
          toolId,
          {
            ...params(toolId),
            sourceUrls: shots.map((shot) => media(shot)),
            clip_durations: shots.map((shot) => shot.duration),
            ...(project.audio.musicUrl ? { musicUrl: project.audio.musicUrl } : {}),
            timeline,
            ...(project.aspectRatio === '1:1' ? { width: 720, height: 720 } : size(project)),
          },
          {
            ...(context.definition.delivery === 'clips' ? { shotId: shots[0].id } : {}),
            apply: {
              target: 'render',
              kind: 'video',
              ...(context.definition.delivery === 'clips'
                ? { shotId: shots[0].id, name: shots[0].title }
                : {}),
            },
          },
          true,
        )
      }
    }
  }
  if (stage.id === 'compose' && phase === 'after') {
    const outputs = outputFiles(context.artifacts.compose ?? context.previous ?? undefined)
    for (const [index, output] of outputs.entries())
      if (typeof output.videoUrl === 'string' && output.videoUrl) {
        let finalVideo: unknown = output.videoUrl
        const hasExternalComposer = automation.postTools.some((toolId) => composers.has(toolId))
        if (
          automation.postTools.includes('remotion_caption_burn') &&
          (!project.audio.burnSubtitles || hasExternalComposer)
        ) {
          const single =
            context.definition.delivery === 'clips'
              ? project.shots.find((shot) => shot.id === output.shotId)
              : undefined
          let offset = 0
          const segments = (single ? [single] : project.shots).flatMap((shot) => {
            const start = offset
            offset += shot.duration
            return shot.caption.trim() ? [{ start, end: offset, text: shot.caption }] : []
          })
          if (segments.length || (typeof output.subtitleUrl === 'string' && output.subtitleUrl)) {
            const burn = add(
              `delivery-${index}-caption-burn`,
              'remotion_caption_burn',
              {
                ...params('remotion_caption_burn'),
                sourceUrl: output.videoUrl,
                ...(output.subtitleUrl ? { subtitleUrl: output.subtitleUrl } : { segments }),
              },
              {
                ...(single ? { shotId: single.id } : {}),
                apply: {
                  target: 'render',
                  kind: 'video',
                  ...(single ? { shotId: single.id, name: single.title } : {}),
                },
              },
              true,
            )!
            finalVideo = ref(burn.key, 'video')
          }
        }
        add(
          `delivery-${index}-qa`,
          'visual_qa',
          {
            sourceUrl: finalVideo,
            operation: 'probe',
            expected: {
              ...(project.aspectRatio === '1:1' ? { width: 720, height: 720 } : size(project)),
              ...(typeof output.duration === 'number'
                ? { min_duration: output.duration - 0.15, max_duration: output.duration + 0.15 }
                : {}),
            },
          },
          { apply: { target: 'artifact' } },
        )
      }
  }
  const hasPublish = context.definition.stages.some((item) => item.id === 'publish')
  if (phase === 'after' && (stage.id === 'publish' || (stage.id === 'compose' && !hasPublish))) {
    const compose =
      context.artifacts.compose ?? (stage.id === 'compose' ? (context.previous ?? undefined) : undefined)
    const outputs = outputFiles(compose)
    const urls = outputs
      .flatMap((output, index) => {
        const processed = steps.find((step) => step.key === `delivery-${index}-caption-burn`)
        return processed
          ? [ref(processed.key, 'video'), ref(processed.key, 'subtitle')]
          : [output.videoUrl, output.subtitleUrl]
      })
      .filter(
        (value) =>
          (typeof value === 'object' && value !== null) ||
          (typeof value === 'string' && value.startsWith('/static/')),
      )
    const manifest = context.previous?.data?.manifestUrl
    if (typeof manifest === 'string' && manifest.startsWith('/static/')) urls.push(manifest)
    if (urls.length)
      add(
        'project-delivery-bundle',
        'export_bundle',
        {
          sourceUrls: [...new Set(urls)],
          title: project.title,
          description: project.plan.summary,
          tags: [project.category],
          ...params('export_bundle'),
        },
        {
          dependsOn: steps.filter((step) => step.toolId === 'visual_qa').map((step) => step.key),
          apply: { target: 'delivery', kind: 'archive' },
        },
      )
  }
  // Stable topological order makes durable checkpoints and retries preserve all already completed calls.
  const known = new Set(steps.map((step) => step.key))
  for (const step of steps)
    for (const dependency of step.dependsOn)
      if (!known.has(dependency) && !context.previous?.data?.toolRuntime)
        throw new PipelineInputRequired(`制作工具缺少前置产物「${dependency}」，请重新生成此阶段。`)
  return steps
}
