/** Independently implemented local production tools. All invocation paths share this bounded runner. */
import { CreativeError } from '../creative-model.js'
import { localDependencies, prepare } from './local-core.js'
import type { LocalContext, LocalDependencies, ToolResult } from './local-core.js'
import { runMediaTool } from './local-media.js'
import { runGraphicsTool } from './local-graphics.js'
import { runAdapterTool } from './local-adapters.js'
export { localToolAvailability } from './local-adapters.js'
export type { LocalContext, LocalDependencies, ToolResult } from './local-core.js'

export const LOCAL_TOOL_IDS: readonly string[] = [
  'audio_probe',
  'audio_energy',
  'frame_sampler',
  'scene_detect',
  'visual_qa',
  'video_analyzer',
  'composition_validator',
  'video_trimmer',
  'video_stitch',
  'auto_reframe',
  'green_screen_processor',
  'green_screen_composite',
  'video_compose',
  'hyperframes_compose',
  'remotion_caption_burn',
  'silence_cutter',
  'bgm_montage_lite',
  'showcase_card',
  'audio_mixer',
  'audio_enhance',
  'music_library',
  'subtitle_gen',
  'upscale',
  'color_grade',
  'face_enhance',
  'eye_enhance',
  'bg_remove',
  'diagram_gen',
  'code_snippet',
  'math_animate',
  'export_bundle',
  'screen_recorder',
  'screen_capture_selector',
  'cap_recorder',
  'blender_world',
  'threejs_world',
  'threejs_asset_catalog',
  'face_tracker',
  'face_restore',
  'character_spec_generator',
  'svg_rig_builder',
  'pose_library_builder',
  'action_timeline_compiler',
  'character_rig_renderer',
  'character_animation_reviewer',
]
type Schema = Record<string, unknown>
const source = {
  type: 'string',
  title: '本地素材',
  format: 'media-url',
  description: '从当前项目或上传素材中选择 /static/ 地址',
}
const sourceUrls = { type: 'array', title: '素材列表', items: source, minItems: 1, maxItems: 30 }
const number = (title: string, minimum: number, maximum: number, defaultValue: number) => ({
  type: 'number',
  title,
  minimum,
  maximum,
  default: defaultValue,
})
const text = (title: string, maximum = 1000) => ({ type: 'string', title, maxLength: maximum })
const options = (title: string, values: string[], defaultValue = values[0]) => ({
  type: 'string',
  title,
  enum: values,
  default: defaultValue,
})
const array = (title: string, properties: Record<string, unknown>, maxItems = 100) => ({
  type: 'array',
  title,
  maxItems,
  items: { type: 'object', properties },
})
const size = { width: number('画面宽度', 64, 3840, 1280), height: number('画面高度', 64, 3840, 720) }
const animation = {
  ...size,
  duration_seconds: number('动画时长（秒）', 0.1, 30, 3),
  fps: number('帧率', 1, 30, 12),
}
const regions = array(
  '处理区域',
  {
    x: number('左侧坐标', 0, 10000, 0),
    y: number('顶部坐标', 0, 10000, 0),
    width: number('区域宽度', 1, 10000, 100),
    height: number('区域高度', 1, 10000, 100),
  },
  20,
)
const segments = array(
  '字幕片段',
  {
    start: number('开始时间', 0, 3600, 0),
    end: number('结束时间', 0, 3600, 3),
    text: text('字幕内容', 3000),
  },
  2000,
)
const characters = array(
  '角色',
  {
    id: text('角色标识', 80),
    name: text('角色名称', 100),
    color: { type: 'string', title: '角色颜色', pattern: '^#[0-9a-fA-F]{6}$', default: '#6da8ff' },
    bodyHeight: number('角色高度', 80, 300, 180),
  },
  12,
)
const actions = array(
  '角色动作',
  {
    characterId: text('角色标识', 80),
    start: number('开始时间', 0, 3600, 0),
    end: number('结束时间', 0, 3600, 3),
    pose: options('动作', ['idle', 'wave', 'walk']),
    x: number('开始横向位置', 0, 1, 0.5),
    toX: number('结束横向位置', 0, 1, 0.5),
  },
  200,
)
const characterDesign = { type: 'object', title: '角色设计', properties: { characters } }
const rigPlan = { type: 'object', title: '角色关节结构', properties: { characters } }
const timeline = { type: 'object', title: '动作时间轴', properties: { actions } }
const world = {
  type: 'object',
  title: '三维场景',
  required: ['objects'],
  properties: {
    title: text('场景名称', 100),
    groundSize: number('地面大小', 1, 2000, 40),
    objects: array(
      '场景物体',
      {
        type: options('物体类型', ['box', 'sphere', 'cone', 'tree']),
        x: number('横坐标', -1000, 1000, 0),
        y: number('高度', -1000, 1000, 0),
        z: number('纵坐标', -1000, 1000, 0),
        size: number('大小', 0.05, 100, 1),
        color: text('颜色（#RRGGBB）', 7),
      },
      200,
    ),
    camera_path: array(
      '摄像机路径',
      {
        x: number('横坐标', -1000, 1000, 8),
        y: number('高度', -1000, 1000, 5),
        z: number('纵坐标', -1000, 1000, 8),
        targetX: number('目标横坐标', -1000, 1000, 0),
        targetY: number('目标高度', -1000, 1000, 0),
        targetZ: number('目标纵坐标', -1000, 1000, 0),
      },
      50,
    ),
  },
}
function schema(properties: Schema, required: string[] = []): Schema {
  return { type: 'object', properties, required, additionalProperties: true }
}

export const localToolFields: Record<string, Schema> = {
  audio_probe: schema({ sourceUrl: source }, ['sourceUrl']),
  audio_energy: schema(
    {
      sourceUrl: source,
      interval: number('能量采样间隔', 0.1, 10, 0.5),
      video_duration_seconds: number('目标视频时长', 0.1, 3600, 30),
    },
    ['sourceUrl'],
  ),
  frame_sampler: schema(
    {
      sourceUrl: source,
      strategy: options('抽帧方式', ['count', 'interval', 'timestamps', 'scene_guided']),
      count: number('画面数量', 1, 50, 8),
      max_frames: number('最多画面数', 1, 50, 20),
      interval_seconds: number('抽帧间隔', 0.1, 3600, 5),
      timestamps: { type: 'array', title: '指定时间', items: { type: 'number' }, maxItems: 50 },
      format: options('图片格式', ['jpg', 'png']),
    },
    ['sourceUrl'],
  ),
  scene_detect: schema(
    {
      sourceUrl: source,
      threshold: number('场景变化阈值', 0.01, 1, 0.3),
      min_scene_length_seconds: number('最短场景时长', 0.1, 120, 0.5),
    },
    ['sourceUrl'],
  ),
  visual_qa: schema(
    {
      sourceUrl: source,
      operation: options('检查方式', ['review', 'probe', 'audio_levels']),
      count: number('抽帧数量', 1, 20, 8),
      expected: {
        type: 'object',
        title: '期望媒体信息',
        properties: {
          width: { type: 'integer' },
          height: { type: 'integer' },
          has_audio: { type: 'boolean' },
          min_duration: { type: 'number' },
          max_duration: { type: 'number' },
          pixel_format: { type: 'string' },
        },
      },
    },
    ['sourceUrl'],
  ),
  video_analyzer: schema({ sourceUrl: source, max_keyframes: number('最多参考画面', 1, 50, 8) }, [
    'sourceUrl',
  ]),
  composition_validator: schema(
    { clips: array('编排片段', { sourceUrl: source, duration: number('片段时长', 0.01, 600, 3) }, 200) },
    ['clips'],
  ),
  video_trimmer: schema(
    {
      sourceUrl: source,
      operation: options('处理方式', ['cut', 'speed']),
      start_seconds: number('开始时间', 0, 3600, 0),
      end_seconds: number('结束时间', 0.01, 3600, 3),
      speed_factor: number('播放速度', 0.1, 100, 1),
    },
    ['sourceUrl'],
  ),
  video_stitch: schema(
    {
      sourceUrls,
      ...size,
      operation: options('合成方式', ['stitch', 'preview_stitch', 'spatial', 'validate']),
      transition: options('转场', ['cut', 'crossfade', 'fade']),
      transition_duration: number('转场时长', 0.1, 3, 0.5),
      layout: options('空间布局', ['side_by_side', 'vertical_stack', 'picture_in_picture']),
    },
    ['sourceUrls'],
  ),
  auto_reframe: schema(
    {
      sourceUrl: source,
      aspect_ratio: options('目标比例', ['9:16', '16:9', '1:1', '4:3']),
      mode: options('构图方式', ['center', 'pad', 'face']),
      focus_x: number('主体横向位置', 0, 1, 0.5),
    },
    ['sourceUrl'],
  ),
  green_screen_processor: schema(
    {
      sourceUrl: source,
      key_color: { type: 'string', title: '抠像颜色', default: '#00ff00' },
      similarity: number('颜色容差', 0.01, 0.8, 0.15),
      blend: number('边缘过渡', 0, 1, 0.08),
      backgroundUrl: source,
      ...size,
    },
    ['sourceUrl'],
  ),
  green_screen_composite: schema(
    {
      sourceUrl: source,
      backgroundUrl: source,
      key_color: { type: 'string', title: '抠像颜色', default: '#00ff00' },
      foreground_scale: number('前景画面大小', 0.1, 1, 0.5),
      ...size,
    },
    ['sourceUrl', 'backgroundUrl'],
  ),
  video_compose: schema(
    {
      sourceUrls,
      clip_durations: {
        type: 'array',
        title: '各图片时长（秒；视频按原时长）',
        items: { type: 'number', minimum: 0.1, maximum: 600 },
      },
      subtitleUrl: { ...source, title: '字幕文件' },
      segments,
      musicUrl: source,
      music_volume: number('配乐音量', 0, 2, 0.2),
      ...size,
    },
    ['sourceUrls'],
  ),
  hyperframes_compose: schema(
    {
      sourceUrls,
      clip_durations: {
        type: 'array',
        title: '各图片时长（秒）',
        items: { type: 'number', minimum: 0.1, maximum: 600 },
      },
      subtitleUrl: { ...source, title: '字幕文件' },
      segments,
      musicUrl: source,
      ...size,
    },
    ['sourceUrls'],
  ),
  remotion_caption_burn: schema(
    {
      sourceUrl: source,
      subtitleUrl: { ...source, title: '字幕文件（可替代下方片段）' },
      segments,
      font_size: number('字幕字号', 10, 72, 26),
    },
    ['sourceUrl'],
  ),
  silence_cutter: schema(
    {
      sourceUrl: source,
      operation: options('处理方式', ['cut', 'detect']),
      threshold_db: number('静音阈值（dB）', -80, -10, -35),
      min_silence_seconds: number('最短静音时间', 0.1, 10, 0.4),
    },
    ['sourceUrl'],
  ),
  bgm_montage_lite: schema(
    {
      sourceUrls,
      musicUrl: source,
      duration_seconds: number('混剪时长', 0.1, 600, 30),
      shot_duration: number('平均镜头时长', 0.5, 15, 4),
      ...size,
    },
    ['sourceUrls', 'musicUrl'],
  ),
  showcase_card: schema(
    {
      title: text('标题', 100),
      subtitle: text('副标题', 180),
      render_video: { type: 'boolean', title: '生成视频', default: false },
      ...animation,
    },
    ['title'],
  ),
  audio_mixer: schema(
    {
      sourceUrls,
      operation: options('混音方式', [
        'mix',
        'duck',
        'fade',
        'normalize',
        'extract_audio',
        'segmented_music',
      ]),
      volumes: { type: 'array', title: '各音轨音量', items: { type: 'number', minimum: 0, maximum: 4 } },
      fade_seconds: number('淡入淡出时间', 0, 10, 0.5),
      sample_rate: number('提取音频采样率', 8000, 96000, 48000),
      channels: number('提取音频声道数', 1, 2, 2),
    },
    ['sourceUrls'],
  ),
  audio_enhance: schema(
    {
      sourceUrl: source,
      preset: options('处理预设', ['speech', 'music', 'normalize', 'denoise']),
      noise_reduction: number('降噪力度', 0.01, 50, 12),
      target_lufs: number('目标响度', -30, -9, -16),
    },
    ['sourceUrl'],
  ),
  music_library: schema({ sourceUrls }),
  subtitle_gen: schema({
    subtitleUrl: { ...source, title: 'SRT / VTT 文件（或填写片段）' },
    segments,
    format: options('字幕格式', ['srt', 'vtt', 'json']),
    max_chars_per_line: number('每行最多字符', 8, 120, 42),
    corrections: { type: 'object', title: '字幕修正词表', additionalProperties: { type: 'string' } },
  }),
  upscale: schema({ sourceUrl: source, scale: number('放大倍数（Lanczos）', 1, 4, 2) }, ['sourceUrl']),
  color_grade: schema(
    {
      sourceUrl: source,
      preset: options('调色预设', ['neutral', 'cinematic', 'warm', 'cool', 'vintage', 'monochrome']),
      brightness: number('亮度', -0.5, 0.5, 0),
      contrast: number('对比度', 0.5, 2, 1),
      saturation: number('饱和度', 0, 3, 1),
    },
    ['sourceUrl'],
  ),
  face_enhance: schema({ sourceUrl: source, regions, strength: number('局部平滑力度', 0, 1, 0.35) }, [
    'sourceUrl',
    'regions',
  ]),
  eye_enhance: schema({ sourceUrl: source, regions, strength: number('眼部增强力度', 0, 1, 0.35) }, [
    'sourceUrl',
    'regions',
  ]),
  bg_remove: schema(
    {
      sourceUrl: source,
      model: options('分割模型', ['u2net', 'u2net_human_seg', 'isnet-general-use']),
      bg_color: text('替换背景色（留空保留透明）', 7),
    },
    ['sourceUrl'],
  ),
  diagram_gen: schema({
    title: text('图表标题', 120),
    definition: text('Mermaid 流程定义（可替代节点列表）', 10000),
    boxes: array('流程节点', { label: text('节点文字', 100), color: text('节点颜色', 7) }, 36),
    connections: array('连接线', {
      from: number('起点序号（从 0 开始）', 0, 35, 0),
      to: number('终点序号（从 0 开始）', 0, 35, 1),
      label: text('连接文字', 80),
    }),
    theme: options('主题', ['dark', 'light', 'neutral']),
    ...size,
  }),
  code_snippet: schema(
    { code: text('代码内容', 12000), title: text('图片标题', 160), language: text('语言名称', 50), ...size },
    ['code'],
  ),
  math_animate: schema(
    {
      expression: { type: 'string', title: '数学表达式', default: 'sin(x+t)', maxLength: 500 },
      x_min: number('横轴起点', -1000, 1000, -6.28),
      x_max: number('横轴终点', -1000, 1000, 6.28),
      y_min: number('纵轴起点', -1000, 1000, -2),
      y_max: number('纵轴终点', -1000, 1000, 2),
      ...animation,
    },
    ['expression'],
  ),
  export_bundle: schema(
    {
      sourceUrls,
      title: text('发布标题', 200),
      description: text('发布描述', 10000),
      tags: { type: 'array', title: '标签', items: { type: 'string' }, maxItems: 100 },
      platform: text('发布平台', 100),
    },
    ['sourceUrls'],
  ),
  screen_recorder: schema({
    duration_seconds: number('录制时长', 1, 600, 10),
    fps: number('录制帧率', 1, 60, 30),
    screen_index: number('屏幕设备序号', 0, 20, 1),
    capture_audio: { type: 'boolean', title: '系统音频（需要独立录屏工具）', default: false },
  }),
  screen_capture_selector: schema({
    operation: options('录屏操作', ['recommend', 'record']),
    duration_seconds: number('录制时长', 1, 600, 10),
    screen_index: number('屏幕设备序号', 0, 20, 1),
  }),
  cap_recorder: schema({ operation: options('环境检查', ['detect', 'status', 'setup_guide']) }),
  blender_world: schema(
    {
      world_spec: world,
      model_urls: { ...sourceUrls, title: '当前项目的 GLB 模型', maxItems: 10, accept: '.glb' },
      render_video: { type: 'boolean', title: '渲染视频', default: true },
      ...animation,
    },
    ['world_spec'],
  ),
  threejs_world: schema(
    {
      world_spec: world,
      model_urls: { ...sourceUrls, title: '当前项目的 GLB 模型', maxItems: 10, accept: '.glb' },
      render_video: { type: 'boolean', title: '渲染视频（需要 Chrome）', default: true },
      operation: options('场景操作', ['build', 'validate']),
      ...animation,
    },
    ['world_spec'],
  ),
  threejs_asset_catalog: schema(
    {
      sourceUrls: { ...sourceUrls, title: '当前项目 GLB 模型地址' },
      license: text('素材许可', 300),
      attribution: text('素材署名', 2000),
    },
    ['sourceUrls'],
  ),
  face_tracker: schema({ sourceUrl: source, sample_fps: number('每秒采样次数', 0.05, 10, 2) }, ['sourceUrl']),
  face_restore: schema(
    { sourceUrl: source, model: options('修复模型', ['GFPGAN']), upscale: number('放大倍数', 1, 4, 2) },
    ['sourceUrl'],
  ),
  character_spec_generator: schema({ characters, brief: text('角色说明', 5000) }, ['characters']),
  svg_rig_builder: schema({ character_design: characterDesign }, ['character_design']),
  pose_library_builder: schema({ rig_plan: rigPlan }, ['rig_plan']),
  action_timeline_compiler: schema(
    {
      scene_plan: { type: 'object', title: '动作规划', properties: { actions } },
      fps: number('帧率', 1, 30, 12),
    },
    ['scene_plan'],
  ),
  character_rig_renderer: schema({ rig_plan: rigPlan, action_timeline: timeline, ...animation }, [
    'rig_plan',
    'action_timeline',
  ]),
  character_animation_reviewer: schema(
    {
      rig_plan: rigPlan,
      action_timeline: timeline,
      review_level: options('审查阶段', ['static', 'browser', 'final']),
      browser_preview_checked: { type: 'boolean', title: '已检查浏览器预览' },
      frame_samples_checked: { type: 'boolean', title: '已检查成片抽帧' },
    },
    ['rig_plan', 'action_timeline'],
  ),
}

export async function runLocalTool(
  ctx: LocalContext,
  overrides: Partial<LocalDependencies> = {},
): Promise<ToolResult> {
  if (!(LOCAL_TOOL_IDS as readonly string[]).includes(ctx.toolId))
    throw new CreativeError('未知的本地制作工具', 422)
  const deps = { ...localDependencies, ...overrides }
  try {
    const folder = await prepare(ctx, deps),
      context = { ...ctx, outputDir: folder }
    ctx.progress(0.02)
    const answer =
      (await runMediaTool(context, deps)) ??
      (await runGraphicsTool(context, deps)) ??
      (await runAdapterTool(context, deps))
    if (!answer) throw new Error('本地工具未配置执行器')
    return answer
  } catch (error) {
    if (error instanceof CreativeError) throw error
    const message = error instanceof Error ? error.message : '本地制作失败'
    throw new CreativeError(
      message.split(deps.root).join('素材目录').slice(0, 1600),
      ctx.signal.aborted ? 409 : 422,
    )
  }
}
