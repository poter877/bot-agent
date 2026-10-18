/** Capability facts only. Implementations are native Video Factory adapters. */
import inventory from './inventory.json' with { type: 'json' }
import { providerPresets, providerToolSpecs } from './providers.js'
import { LOCAL_TOOL_IDS, localToolFields, localToolAvailability } from './local.js'
import { auxiliaryIds, auxiliaryFields, acquisitionDomains } from './auxiliary.js'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { db, schema } from '../../db/index.js'
import { serviceProviders, rankConfigs } from '../ai-registry.js'
import type { ToolDefinition, ToolField, ProviderPreset } from './contracts.js'
const categories: Record<string, string> = {
  graphics: '图像与图形',
  video: '视频与剪辑',
  audio: '声音与音乐',
  analysis: '分析与质检',
  enhancement: '画面增强',
  character: '角色动画',
  capture: '录屏与采集',
  avatar: '数字人与口型',
  publishers: '交付与导出',
  subtitle: '字幕',
  stock: '素材取材',
}
const names: Record<string, string> = {
  audio_probe: '音频信息',
  audio_energy: '音量与节奏分析',
  frame_sampler: '视频抽帧',
  scene_detect: '场景切分检测',
  visual_qa: '画面质量检查',
  video_analyzer: '视频技术分析',
  composition_validator: '合成方案检查',
  video_trimmer: '视频裁剪',
  video_stitch: '片段拼接',
  video_compose: '画面合成',
  auto_reframe: '自动适配画幅',
  green_screen_processor: '绿幕处理',
  green_screen_composite: '绿幕换背景',
  silence_cutter: '静音片段裁切',
  bgm_montage_lite: '音乐节奏混剪',
  showcase_card: '展示卡片',
  audio_mixer: '音频混音',
  audio_enhance: '音频增强',
  music_library: '项目音乐库',
  subtitle_gen: '字幕生成',
  remotion_caption_burn: '字幕烧录',
  upscale: '画面放大',
  color_grade: '调色',
  face_enhance: '人物画面增强',
  eye_enhance: '眼部画面增强',
  face_restore: '人脸修复',
  bg_remove: '背景去除',
  diagram_gen: '图表生成',
  code_snippet: '代码卡片',
  math_animate: '数学动画',
  export_bundle: '交付文件包',
  screen_recorder: '屏幕录制',
  screen_capture_selector: '录屏方式选择',
  cap_recorder: '录屏采集',
  blender_world: 'Blender 三维场景',
  threejs_world: '三维场景制作',
  threejs_asset_catalog: '三维资产库',
  face_tracker: '人脸跟踪',
  character_spec_generator: '角色设定',
  svg_rig_builder: 'SVG 角色绑定',
  pose_library_builder: '动作姿态库',
  action_timeline_compiler: '动作时间线',
  character_rig_renderer: '角色动画渲染',
  character_animation_reviewer: '角色动画检查',
  image_gen: '图片生成',
  image_selector: '图片模型选择',
  video_selector: '视频模型选择',
  tts_selector: '配音模型选择',
  clip_search: '片段检索',
  corpus_builder: '素材索引',
  direct_clip_search: '联网片段来源检索',
  video_downloader: '网页视频获取',
  transcript_fetcher: '网页字幕获取',
  video_understand: '视频画面理解',
  transcriber: '字幕时码识别',
  lip_sync: '视频口型同步',
  talking_head: '人物图口播',
}
const prompt: ToolField = { key: 'prompt', label: '生成描述', type: 'text', required: true }
const text: ToolField = { key: 'text', label: '配音文字', type: 'text', required: true }
const source: ToolField = { key: 'sourceUrl', label: '原始素材', type: 'media', required: true }
export const sharedToolSpecs: Record<string, { serviceType?: string; provider: string; mode: string }> = {
  image_gen: { serviceType: 'image', provider: 'shared', mode: 'image' },
  image_selector: { serviceType: 'image', provider: 'shared', mode: 'image' },
  video_selector: { serviceType: 'video', provider: 'shared', mode: 'video' },
  tts_selector: { serviceType: 'speech', provider: 'shared', mode: 'speech' },
  transcriber: { serviceType: 'transcription', provider: 'openai', mode: 'transcription' },
  lip_sync: { serviceType: 'lipsync', provider: 'sync', mode: 'lipsync' },
  talking_head: { serviceType: 'lipsync', provider: 'sync', mode: 'lipsync' },
  kling_lip_sync: { serviceType: 'lipsync', provider: 'sync', mode: 'lipsync' },
  kling_avatar: { serviceType: 'lipsync', provider: 'sync', mode: 'lipsync' },
  piper_tts: { provider: 'local', mode: 'piper' },
}
const generationKinds: Record<string, string> = {
  image_generation: 'image',
  video_generation: 'video',
  tts: 'speech',
  music_generation: 'music',
  '3d_asset_generation': 'model3d',
}
for (const item of inventory) {
  if (
    !providerToolSpecs[item.id] &&
    !LOCAL_TOOL_IDS.includes(item.id) &&
    !auxiliaryIds.includes(item.id) &&
    !sharedToolSpecs[item.id]
  ) {
    const kind = generationKinds[item.capability]
    if (kind) sharedToolSpecs[item.id] = { serviceType: kind, provider: 'shared', mode: kind }
  }
}
export function toolboxProviderPresets(): ProviderPreset[] {
  const entries: ProviderPreset[] = Object.entries(providerPresets).flatMap(([serviceType, providers]) =>
    Object.entries(providers).map(([provider, preset]) => ({
      provider,
      serviceType,
      name: preset.label,
      baseUrl: preset.baseUrl,
      models: preset.models,
      requiresApiKey: preset.requiresApiKey,
    })),
  )
  for (const preset of [
    {
      provider: 'sync',
      serviceType: 'lipsync',
      name: 'Sync 口型同步',
      baseUrl: 'https://api.sync.so',
      models: ['lipsync-2', 'lipsync-2-pro', 'sync-3'],
    },
    {
      provider: 'tavily',
      serviceType: 'research',
      name: 'Tavily 来源检索',
      baseUrl: 'https://api.tavily.com',
      models: ['search'],
    },
    {
      provider: 'openai',
      serviceType: 'transcription',
      name: 'OpenAI 字幕时码识别',
      baseUrl: 'https://api.openai.com',
      models: ['whisper-1'],
    },
  ]) {
    if (!entries.some((p) => p.provider === preset.provider && p.serviceType === preset.serviceType))
      entries.push(preset)
  }
  return entries
}
function fieldsFromSchema(id: string): ToolField[] {
  const schema = localToolFields[id] as any
  if (!schema) return []
  const properties = schema.properties ?? schema
  return Object.entries(properties)
    .filter(([key, value]) => key !== 'required' && value && typeof value === 'object')
    .map(([key, value]) => {
      const field = value as any
      return {
        key,
        label: field.title ?? field.description ?? key,
        type: field.enum
          ? 'select'
          : field.type === 'boolean'
            ? 'boolean'
            : field.type === 'number' || field.type === 'integer'
              ? 'number'
              : field.type === 'object' || field.type === 'array'
                ? 'json'
                : field.format === 'media-url' || /url|path|source/i.test(key)
                  ? 'media'
                  : 'text',
        required: Array.isArray(schema.required) && schema.required.includes(key),
        default: field.default,
        accept:
          field.accept ??
          field.items?.accept ??
          (id === 'threejs_asset_catalog' ? '.glb' : key === 'subtitleUrl' ? '.srt,.vtt' : undefined),
        options: field.enum?.map((value: any) => ({ label: String(value), value: String(value) })),
      } as ToolField
    })
}
function inputs(id: string, mode?: string, provider?: string): ToolField[] {
  if (auxiliaryFields[id]) return auxiliaryFields[id]
  if (acquisitionDomains[id]) return [{ key: 'query', label: '取材关键词', type: 'text', required: true }]
  if (LOCAL_TOOL_IDS.includes(id)) {
    const fields = fieldsFromSchema(id)
    return fields.length
      ? fields
      : [source, { key: 'options', label: '制作参数（JSON）', type: 'json', default: {} }]
  }
  if (mode === 'lipsync') return [{ key: 'shotId', label: '人物镜头', type: 'text', required: true }]
  if (mode === 'transcription') return [source]
  if (mode === 'piper') return [text, { key: 'speaker', label: '音色编号', type: 'number', default: 0 }]
  const spec = providerToolSpecs[id],
    serviceType = spec?.serviceType ?? sharedToolSpecs[id]?.serviceType
  let fields: ToolField[] =
    serviceType === 'stock'
      ? [
          { key: 'query', label: '取材关键词', type: 'text', required: true },
          { key: 'download', label: '下载选中的结果', type: 'boolean', default: false },
          { key: 'index', label: '候选编号（从0开始）', type: 'number', default: 0 },
        ]
      : serviceType === 'speech'
        ? [
            text,
            { key: 'voice', label: '音色或 Voice ID', type: 'text' },
            { key: 'language', label: '语言代码', type: 'text', default: 'zh-CN' },
          ]
        : serviceType === 'transcription'
          ? [source]
          : serviceType === 'avatar'
            ? [
                text,
                { key: 'avatar_id', label: 'Avatar ID（或提供人物图）', type: 'text' },
                { key: 'voice_id', label: 'Voice ID', type: 'text', required: true },
                { key: 'image_url', label: '人物图片', type: 'media', accept: 'image/*' },
              ]
            : [
                prompt,
                ...(serviceType === 'video' || serviceType === 'music'
                  ? [
                      {
                        key: 'duration',
                        label: '时长（秒）',
                        type: 'number' as const,
                        default: serviceType === 'music' ? 30 : 5,
                      },
                    ]
                  : []),
                ...(serviceType === 'image' || serviceType === 'video'
                  ? [
                      { key: 'image_url', label: '参考图片', type: 'media' as const, accept: 'image/*' },
                      {
                        key: 'aspect_ratio',
                        label: '画面比例',
                        type: 'select' as const,
                        default: '16:9',
                        options: [
                          { label: '横屏 16:9', value: '16:9' },
                          { label: '竖屏 9:16', value: '9:16' },
                          { label: '方形 1:1', value: '1:1' },
                        ],
                      },
                    ]
                  : []),
              ]
  if (id === 'h3_max_video')
    fields = fields.map((field) => (field.key === 'image_url' ? { ...field, required: true } : field))
  if (serviceType === 'stock')
    fields.push({
      key: 'media_type',
      label: '素材类型',
      type: 'select',
      default: id.includes('video') ? 'video' : 'image',
      options: [
        { label: '图片', value: 'image' },
        { label: '视频', value: 'video' },
      ],
    })
  if (serviceType === 'transcription')
    fields = fields.map((field) =>
      field.key === 'sourceUrl' ? { ...field, key: 'audio_url', label: '识别音频' } : field,
    )
  if (provider === 'google')
    fields.push(
      { key: 'google_project', label: 'Google Cloud 项目 ID', type: 'text', required: true },
      { key: 'location', label: 'Google Cloud 地域', type: 'text', default: 'us-central1' },
    )
  if (serviceType === 'model3d' && provider === 'fal')
    fields = [{ key: 'image_url', label: '建模参考图片', type: 'media', required: true, accept: 'image/*' }]
  if (provider === 'comfyui')
    fields = [
      ...fields,
      { key: 'workflow_json', label: 'API 工作流 JSON', type: 'json' },
      { key: 'prompt_node', label: '提示词节点 ID', type: 'text' },
    ]
  fields.push({ key: 'parameters', label: '高级服务参数（JSON）', type: 'json', default: {} })
  return fields
}
export function getToolDefinition(id: string): ToolDefinition {
  const item = inventory.find((item) => item.id === id)
  if (!item) throw new Error('制作工具不存在')
  const local = LOCAL_TOOL_IDS.includes(id),
    spec = providerToolSpecs[id] ?? sharedToolSpecs[id],
    aux = auxiliaryIds.includes(id)
  const implemented = local || !!spec || aux
  const serviceType =
    acquisitionDomains[id] || id === 'direct_clip_search'
      ? 'research'
      : id === 'video_understand'
        ? 'text'
        : spec?.serviceType
  const provider = local
    ? 'local'
    : acquisitionDomains[id] || id === 'direct_clip_search'
      ? 'tavily'
      : id === 'video_understand'
        ? 'shared'
        : (spec?.provider ?? 'local')
  const replacement =
    !!sharedToolSpecs[id] &&
    ![
      'image_gen',
      'image_selector',
      'video_selector',
      'tts_selector',
      'transcriber',
      'lip_sync',
      'talking_head',
      'piper_tts',
    ].includes(id)
  const featureName =
    id === 'sora_video'
      ? '视频生成（Sora 接口已停用，使用替代服务）'
      : id === 'google_imagen'
        ? 'Google 图像（Imagen 已迁移 Nano Banana）'
        : (names[id] ?? id.replace(/_/g, ' '))
  const description = replacement
    ? `通过统一${serviceType}服务实现此项功能；可在模型与服务中选择实际使用的模型。原参考项：${item.referenceProvider || item.id}。`
    : acquisitionDomains[id]
      ? `检索 ${acquisitionDomains[id]} 的素材来源页面，保留出处；候选页面需检查文件与许可。`
      : `${featureName}，支持独立执行、产物检查和导入项目。`
  let available: boolean = implemented,
    reason: string | undefined = implemented ? undefined : '该项尚无可执行实现'
  if (serviceType) {
    const config = db
      .select()
      .from(schema.aiServiceConfigs)
      .all()
      .filter(
        (c) =>
          c.serviceType === serviceType &&
          c.isActive &&
          (provider === 'shared' || c.provider === provider) &&
          (serviceProviders[serviceType] || []).includes(c.provider || ''),
      )
      .sort(rankConfigs)[0]
    const preset = toolboxProviderPresets().find(
      (p) => p.provider === (config?.provider ?? provider) && p.serviceType === serviceType,
    )
    if (
      (!config || (!config.apiKey && preset?.requiresApiKey !== false)) &&
      !['nasa', 'wikimedia', 'archive_org', 'loc'].includes(config?.provider ?? provider)
    ) {
      available = false
      reason = `请在模型与服务中配置${provider === 'shared' ? serviceType : provider}`
    }
  }
  return {
    id,
    name: featureName,
    category: categories[item.category] ?? item.category,
    provider,
    referenceProvider: item.referenceProvider,
    description,
    serviceType,
    inputs: inputs(id, (sharedToolSpecs[id] as any)?.mode, provider),
    implemented,
    available,
    reason,
  }
}
export async function toolboxCatalog() {
  const tools = await Promise.all(
    inventory.map(async (item) => {
      const definition = getToolDefinition(item.id)
      if (LOCAL_TOOL_IDS.includes(item.id)) {
        const availability = await localToolAvailability(item.id)
        if (!availability.available) return { ...definition, available: false, reason: availability.reason }
      }
      if (item.id === 'piper_tts') {
        if (!process.env.PIPER_MODEL)
          return {
            ...definition,
            available: false,
            reason: '请安装 Piper 并配置 PIPER_MODEL 和可选 PIPER_BIN',
          }
        try {
          await fs.access(process.env.PIPER_MODEL)
        } catch {
          return { ...definition, available: false, reason: 'PIPER_MODEL 文件不存在或不可读' }
        }
      }
      if (['piper_tts', 'video_downloader', 'transcript_fetcher'].includes(item.id)) {
        const binary =
          item.id === 'piper_tts' ? process.env.PIPER_BIN || 'piper' : process.env.YTDLP_BIN || 'yt-dlp'
        const available = await new Promise<boolean>((resolve) =>
          execFile(binary, ['--version'], { timeout: 5000, maxBuffer: 65536 }, (error) => resolve(!error)),
        )
        if (!available)
          return {
            ...definition,
            available: false,
            reason:
              item.id === 'piper_tts' ? '请安装 Piper 并配置 PIPER_BIN' : '请安装 yt-dlp 并配置 YTDLP_BIN',
          }
      }
      return definition
    }),
  )
  return { tools, providers: toolboxProviderPresets(), referenceCount: inventory.length }
}
