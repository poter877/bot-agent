/** Native workflow placement. Model adapters are alternatives, never a fan-out list of billable calls. */
import inventory from '../production-tools/inventory.json' with { type: 'json' }
import { creativeCategoryIds, type CreativeCategory } from '../creative-catalog.js'
import type { StageKind } from './definitions.js'

export type PipelineToolRole =
  | 'analysis'
  | 'research'
  | 'visual'
  | 'voice'
  | 'music'
  | 'post'
  | 'model'
  | 'delivery'
  | 'interactive'
export type PipelineToolSelection =
  | 'image'
  | 'video'
  | 'speech'
  | 'transcription'
  | 'music'
  | 'stock'
  | 'research'
  | 'avatar'
  | 'model3d'
  | 'capture'
export interface PipelineToolPolicy {
  toolId: string
  mode: 'default' | 'selectable' | 'interactive'
  role: PipelineToolRole
  stages: StageKind[]
  categories: CreativeCategory[]
  purpose: string
  trigger: string
  selectionKey?: PipelineToolSelection
}
const all = [...creativeCategoryIds]
const original: CreativeCategory[] = [
  'explainer',
  'cinematic',
  'animation',
  'character_animation',
  'documentary',
  'hybrid',
  'avatar',
]
const illustrated: CreativeCategory[] = [
  'explainer',
  'animation',
  'character_animation',
  'documentary',
  'hybrid',
  'avatar',
  'screen_demo',
  'podcast',
]
const sourced: CreativeCategory[] = [
  'documentary',
  'hybrid',
  'talking_head',
  'screen_demo',
  'podcast',
  'clip_factory',
  'localization',
]
const presenters: CreativeCategory[] = ['talking_head', 'avatar', 'podcast', 'clip_factory', 'localization']
const researched: CreativeCategory[] = [
  'explainer',
  'documentary',
  'cinematic',
  'animation',
  'character_animation',
  'hybrid',
  'avatar',
]
const policies: Record<string, PipelineToolPolicy> = {}
function group(ids: string[], policy: Omit<PipelineToolPolicy, 'toolId'>) {
  for (const toolId of ids) {
    if (policies[toolId]) throw new Error(`重复的流程工具策略：${toolId}`)
    policies[toolId] = { toolId, ...policy }
  }
}
const selectable = (
  role: PipelineToolRole,
  stages: StageKind[],
  categories: CreativeCategory[],
  purpose: string,
  trigger: string,
  selectionKey?: PipelineToolSelection,
): Omit<PipelineToolPolicy, 'toolId'> => ({
  mode: 'selectable',
  role,
  stages,
  categories,
  purpose,
  trigger,
  ...(selectionKey ? { selectionKey } : {}),
})
const defaulted = (
  role: PipelineToolRole,
  stages: StageKind[],
  categories: CreativeCategory[],
  purpose: string,
  trigger: string,
): Omit<PipelineToolPolicy, 'toolId'> => ({ mode: 'default', role, stages, categories, purpose, trigger })

group(
  [
    'atlas_image',
    'atlas_refresh_image',
    'comfyui_image',
    'dashscope_image',
    'flux_image',
    'gemini_fal_image',
    'gemini_replicate_image',
    'google_imagen',
    'grok_image',
    'ideogram_fal_image',
    'ideogram_image',
    'image_gen',
    'image_selector',
    'kling_official_image',
    'local_diffusion',
    'minimax_image',
    'openai_fal_image',
    'openai_image',
    'qwen_image_21',
    'recraft_image',
    'seedream_image',
    'hunyuan_image',
  ],
  selectable(
    'visual',
    ['assets'],
    original,
    '制作缺失的插画、分镜图或角色参考图；同能力模型只选一项',
    '镜头缺少画面且选择该图片服务；纪录证据与真实软件界面不允许生成替代',
    'image',
  ),
)
group(
  [
    'atlas_video',
    'cogvideo_video',
    'comfyui_video',
    'gemini_omni_fal',
    'gemini_omni_video',
    'grok_video',
    'h3_max_video',
    'higgsfield_video',
    'hunyuan_cloud_video',
    'hunyuan_video',
    'jimeng_video',
    'kling_official_video',
    'kling_video',
    'ltx_api_video',
    'ltx_video_local',
    'ltx_video_modal',
    'minimax_fal_video',
    'minimax_video',
    'runway_video',
    'seedance_ark',
    'seedance_replicate',
    'seedance_video',
    'sora_video',
    'veo_video',
    'video_selector',
    'wan_atlas_video',
    'wan_fal_video',
    'wan_replicate_video',
    'wan_video',
  ],
  selectable(
    'visual',
    ['assets'],
    original,
    '制作缺失的动态镜头；通过统一服务选择一个已配置的视频模型，停用原厂标明替代',
    '镜头声明需要生成视频且无现成画面，单镜头不超过生成服务时长',
    'video',
  ),
)
group(
  [
    'azure_tts',
    'cartesia_tts',
    'dashscope_tts',
    'doubao_tts',
    'elevenlabs_tts',
    'fal_elevenlabs_tts',
    'fish_audio_tts',
    'gemini_tts',
    'google_tts',
    'inworld_tts',
    'kling_tts',
    'openai_tts',
    'piper_tts',
    'tts_selector',
  ],
  selectable(
    'voice',
    ['assets'],
    all,
    '将批准讲稿合成逐镜头配音并匹配真实时长，保留原片类默认不重配嘉宾原话',
    '已开启配音且镜头有讲稿、缺少配音；同能力音色服务只选一项',
    'speech',
  ),
)
group(
  ['transcriber', 'azure_stt', 'dashscope_asr'],
  selectable(
    'analysis',
    ['research', 'idea', 'script'],
    sourced,
    '为原片建立可核对的逐字稿；自动字幕必须使用真实时码，不伪造文本模型时间轴',
    '已开启转录且原片无逐字稿；文本型ASR只能写文本，不能替代精确字幕',
    'transcription',
  ),
)
group(
  ['comfyui_music', 'fal_elevenlabs_music', 'google_music', 'music_gen', 'suno_music'],
  selectable(
    'music',
    ['assets'],
    all,
    '依据配乐方向生成独立音乐音轨，再进入响度检查和混音',
    '已开启音乐生成、存在配乐说明且无音乐轨',
    'music',
  ),
)
group(
  ['freesound_music', 'pixabay_music'],
  selectable(
    'music',
    ['assets'],
    all,
    '检索并下载有来源署名的音乐或音效，供已批准的声音计划使用',
    '选择该声音来源及明确检索词，下载选中项并保留许可',
    'music',
  ),
)
group(
  [
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
  ],
  selectable(
    'research',
    ['research', 'idea', 'assets'],
    researched,
    '搜索真实图片或视频，下载选定候选并将署名写入项目素材，再按镜头取用',
    '启用该素材源且有检索词；不得将不同素材源重复并发下载同一镜头',
    'stock',
  ),
)
group(
  ['coverr', 'dareful', 'esa', 'jaxa', 'mixkit', 'nara', 'noaa', 'pond5_pd', 'videvo', 'direct_clip_search'],
  selectable(
    'research',
    ['research', 'idea'],
    researched,
    '发现来源网页并写入待核实资料；这些来源适配器不把网页冒充可直接下载的视频',
    '开启联网资料研究并选中对应来源；需要媒体时再由可验证下载链接入库',
    'research',
  ),
)
group(
  ['video_downloader'],
  selectable(
    'research',
    ['research', 'idea'],
    sourced.concat(['explainer', 'avatar']),
    '从用户明确提供的网址获取真实视频并保留来源，随后做探测、逐字稿与镜头选段',
    '填写允许站点的原片网址并明确开启网页获取',
    'research',
  ),
)
group(
  ['transcript_fetcher'],
  selectable(
    'analysis',
    ['research', 'idea'],
    sourced.concat(['explainer', 'avatar']),
    '从提供的网址获取真实字幕并写回相应原始素材，保留已有时码',
    '明确选择网页字幕获取并提供来源网址',
    'research',
  ),
)
group(
  ['atlas_3d', 'fal_3d'],
  selectable(
    'model',
    ['character_design', 'rig_plan', 'assets'],
    ['character_animation', 'animation', 'cinematic', 'explainer'],
    '生成模型并写入项目三维资产；需要骨骼或渲染时串联后续工具，模型本身不是影片',
    '结构化分镜明确需要三维模型且启用对应服务',
    'model3d',
  ),
)
group(
  ['heygen_avatar', 'heygen_video'],
  selectable(
    'visual',
    ['assets'],
    ['avatar'],
    '依据批准讲稿和已选形象生成真实数字人口播，再应用为该镜头视频',
    '选择HeyGen数字人服务并提供该服务实际要求的形象/音色',
    'avatar',
  ),
)
group(
  ['kling_avatar', 'kling_lip_sync', 'lip_sync', 'talking_head'],
  selectable(
    'post',
    ['assets'],
    ['avatar', 'character_animation', 'localization', 'hybrid'],
    '将人物画面与真实逐镜头配音送入Sync口型服务，完成后替换镜头视频',
    '开启口型同步、人物画面与配音均已就绪；只调用一个口型适配器',
    'avatar',
  ),
)

group(
  ['audio_probe'],
  defaulted(
    'analysis',
    ['research', 'idea', 'assets'],
    all,
    '检查实际原音/配音/音乐的时长与流信息，供音轨对齐和选段',
    '存在待处理音轨或带音频原片',
  ),
)
group(
  ['audio_energy'],
  defaulted(
    'analysis',
    ['research', 'idea', 'assets'],
    ['podcast', 'talking_head', 'clip_factory', 'cinematic', 'animation'],
    '计算真实能量节奏，辅助原声选段与音乐节奏，不伪称语义识别',
    '存在音轨且流程需要节奏或口播停顿分析',
  ),
)
group(
  ['frame_sampler'],
  defaulted(
    'analysis',
    ['research', 'idea', 'compose'],
    sourced,
    '从真实视频抽取有时间戳的参考帧，供分镜与成片检查',
    '原始素材是视频，或成片已产生',
  ),
)
group(
  ['scene_detect'],
  defaulted(
    'analysis',
    ['research', 'idea'],
    ['clip_factory', 'documentary', 'hybrid', 'talking_head', 'screen_demo'],
    '检测真实切点并把可用时间范围传给脚本与选段阶段',
    '存在原视频且需要镜头/片段分析',
  ),
)
group(
  ['video_analyzer'],
  defaulted(
    'analysis',
    ['research', 'idea'],
    all,
    '合并技术信息、切点、抽帧与音量分析，形成后续编排的真实依据',
    '源片型流程导入了视频',
  ),
)
group(
  ['video_understand'],
  selectable(
    'analysis',
    ['research', 'idea'],
    sourced.concat(['explainer']),
    '使用实际抽帧和视觉模型理解已导入画面，结果带采样局限并供编排参考',
    '明确启用视觉理解且配置多模态文本模型',
  ),
)
group(
  ['corpus_builder'],
  defaulted(
    'analysis',
    ['research', 'idea'],
    sourced,
    '建立项目原稿和素材索引，将真实来源及时间片段供后续检索',
    '至少存在一份原始素材或逐字稿',
  ),
)
group(
  ['clip_search'],
  defaulted(
    'analysis',
    ['script', 'scene_plan'],
    ['documentary', 'hybrid', 'talking_head', 'screen_demo', 'podcast', 'clip_factory'],
    '依据用户选段目标检索当前项目真实带时码原稿，不生成不存在的原话',
    '已有原稿且需要从素材中选段',
  ),
)
group(
  ['composition_validator'],
  defaulted('analysis', ['edit'], all, '校验实际片段、顺序和总时长，失败即停止合成', '所有镜头已有可用媒体'),
)
group(
  ['visual_qa'],
  defaulted(
    'analysis',
    ['assets', 'compose'],
    all,
    '探测实际媒体尺寸、流与时长，检查问题写入验片报告',
    '新制作镜头或成片已产生',
  ),
)
group(
  ['video_trimmer'],
  defaulted(
    'post',
    ['assets', 'edit'],
    sourced,
    '按已批准的真实源时码切出片段，后续重构图和增强只处理所选范围',
    '镜头绑定源视频并存在非零起点或选段小于原片',
  ),
)
group(
  ['auto_reframe'],
  defaulted(
    'post',
    ['assets'],
    ['clip_factory', 'talking_head', 'podcast', 'hybrid', 'documentary', 'screen_demo', 'avatar'],
    '将真实选段适配项目画幅；有脸部跟踪时使用真实主体坐标，录屏优先留边',
    '原视频比例与交付比例不符或明确选择适配',
  ),
)
group(
  ['face_tracker'],
  selectable(
    'analysis',
    ['assets'],
    presenters,
    '检测真实人脸坐标，供重构图和局部处理，不把中心裁切冒充人脸跟踪',
    '开启人物跟踪且已安装OpenCV运行环境',
  ),
)
group(
  ['silence_cutter'],
  selectable(
    'post',
    ['research', 'idea', 'assets'],
    ['talking_head', 'podcast', 'clip_factory', 'screen_demo'],
    '先检测静音、可选裁切；改变时间轴的裁切必须同步字幕和选段范围',
    '明确开启静音检测或允许删静音；默认只检测不改原声',
  ),
)
group(
  ['audio_enhance'],
  selectable(
    'post',
    ['assets'],
    all,
    '对选中音轨做降噪与响度归一化，再回写逐镜头配音或整片音轨',
    '开启音频处理且存在目标音轨',
  ),
)
group(
  ['audio_mixer'],
  selectable(
    'post',
    ['assets', 'compose'],
    all,
    '提取音轨、混音或压低配乐，使用实际音频输出供后续合成',
    '批准声音计划选择混音/提取，且有相应音轨',
  ),
)
group(
  ['music_library'],
  defaulted(
    'music',
    ['assets'],
    all,
    '检查项目已有音乐，优先复用用户选择的曲目而非重复生成',
    '项目已有配乐或音乐来源',
  ),
)
group(
  ['subtitle_gen'],
  defaulted(
    'post',
    ['edit', 'publish'],
    all,
    '将真实字幕时序或已批准逐镜头字幕导出SRT/VTT，供烧录与交付',
    '存在非空字幕',
  ),
)
group(
  ['remotion_caption_burn'],
  selectable(
    'post',
    ['compose'],
    all,
    '把已核对的真实字幕烧录到视频，供明确选择独立字幕后处理的流程',
    '选择字幕后处理；普通合成已烧录时不得重复烧录',
  ),
)
group(
  ['video_compose', 'hyperframes_compose', 'video_stitch'],
  selectable(
    'post',
    ['compose'],
    all,
    '按批准的结构化片段顺序合成实际视频；选择一个合成器，保留现有配音和字幕配置',
    '显式选用该合成器；默认项目渲染器已承担同一职责时不重复合成',
  ),
)
group(
  ['bgm_montage_lite'],
  selectable(
    'post',
    ['assets', 'compose'],
    ['cinematic', 'hybrid', 'documentary', 'animation'],
    '按批准音乐节奏制作补充混剪段，结果进入对应镜头并保留原作证据来源',
    '分镜明确选择音乐节奏混剪且素材与音乐均已就绪',
  ),
)
group(
  ['green_screen_processor', 'green_screen_composite'],
  selectable(
    'post',
    ['assets'],
    ['avatar', 'hybrid', 'character_animation', 'screen_demo'],
    '对指定绿幕素材抠像并合成指定真实背景，产物替换目标镜头',
    '结构化分镜指定绿幕、颜色和背景素材',
  ),
)
group(
  ['color_grade'],
  selectable(
    'post',
    ['assets'],
    ['cinematic', 'hybrid', 'documentary', 'character_animation'],
    '将选定镜头按批准色调统一处理并回写画面',
    '开启调色并指定真实预设',
  ),
)
group(
  ['upscale'],
  selectable(
    'post',
    ['assets'],
    all,
    '使用实际放大工具处理选定低分辨率画面，不宣称生成不存在的细节',
    '明确选择画面放大与倍率',
  ),
)
group(
  ['face_enhance', 'eye_enhance'],
  selectable(
    'post',
    ['assets'],
    presenters.concat(['cinematic', 'character_animation']),
    '只处理用户或真实检测给出的面部/眼部区域，结果回写目标镜头',
    '指定有效区域并开启对应局部增强',
  ),
)
group(
  ['face_restore'],
  selectable(
    'post',
    ['assets'],
    ['documentary', 'talking_head', 'avatar', 'podcast', 'clip_factory'],
    '用实际GFPGAN修复需要处理的人脸素材并回写，不替换事实依据原件',
    '明确启用修复且部署GFPGAN权重',
  ),
)
group(
  ['bg_remove'],
  selectable(
    'post',
    ['assets'],
    ['explainer', 'avatar', 'hybrid', 'character_animation', 'animation'],
    '为选定角色/前景图分割背景，并把透明前景交给合成步骤',
    '分镜明确需要移除背景且部署rembg权重',
  ),
)

group(
  ['diagram_gen'],
  defaulted(
    'visual',
    ['assets'],
    illustrated,
    '依据已批准的节点、连接或Mermaid结构生成准确图解并应用到对应镜头',
    '结构化分镜标为diagram并提供实际图表定义',
  ),
)
group(
  ['code_snippet'],
  defaulted(
    'visual',
    ['assets'],
    ['explainer', 'animation', 'screen_demo'],
    '把用户或脚本给出的真实代码渲染成清晰代码卡片，供讲解镜头使用',
    '结构化分镜标为code并提供实际代码',
  ),
)
group(
  ['math_animate'],
  defaulted(
    'visual',
    ['assets'],
    ['explainer', 'animation'],
    '把结构化数学表达式渲染为真实曲线动画，不执行任意Python或模型代码',
    '结构化分镜标为math并提供受支持表达式',
  ),
)
group(
  ['showcase_card'],
  defaulted(
    'visual',
    ['assets'],
    illustrated,
    '把批准的标题、观点或音频播客文案制作成可读卡片并应用到镜头',
    '结构化分镜标为card或音频播客缺少承载画面',
  ),
)
group(
  ['character_spec_generator'],
  defaulted(
    'model',
    ['character_design', 'assets'],
    ['character_animation'],
    '将已批准的结构化角色描述变成固定规格，作为所有镜头共同输入',
    '选择SVG关节角色动画路径并提供角色表',
  ),
)
group(
  ['svg_rig_builder', 'pose_library_builder'],
  defaulted(
    'model',
    ['rig_plan', 'assets'],
    ['character_animation'],
    '以同一角色规格建立关节结构和姿态库，产物传给动作时间轴与渲染',
    '角色规格已存在且选择SVG关节动画路径',
  ),
)
group(
  ['action_timeline_compiler', 'character_rig_renderer'],
  defaulted(
    'visual',
    ['assets'],
    ['character_animation'],
    '编译批准动作时间轴并以真实角色关节结构逐帧渲染，成片应用到对应镜头',
    '镜头给出结构化角色动作，依赖角色规格、绑定和姿态库',
  ),
)
group(
  ['character_animation_reviewer'],
  defaulted(
    'analysis',
    ['assets'],
    ['character_animation'],
    '检查角色引用与动作时间轴一致性，错误停止后续渲染或验片',
    'SVG关节链已建立；程序检查不冒充人工浏览器确认',
  ),
)
group(
  ['threejs_asset_catalog'],
  defaulted(
    'model',
    ['rig_plan', 'assets'],
    ['character_animation', 'animation', 'cinematic', 'explainer'],
    '检查当前项目真实GLB模型并记录资产清单，供后续场景/绑定引用',
    '结构化制作计划引用已导入GLB模型',
  ),
)
group(
  ['blender_world'],
  selectable(
    'visual',
    ['assets'],
    ['character_animation', 'animation', 'cinematic', 'explainer'],
    '以批准的结构化场景调用本机Blender渲染实际视频并应用到镜头',
    '分镜明确选择Blender且提供world_spec和可用运行环境',
  ),
)
group(
  ['threejs_world'],
  selectable(
    'model',
    ['assets'],
    ['character_animation', 'animation', 'cinematic', 'explainer'],
    '生成可交互的结构化三维场景工程供预览；浏览器场景不是已渲染影片',
    '分镜明确选择Three.js场景；需要影片时必须接实际录制/渲染',
  ),
)
group(['screen_capture_selector', 'screen_recorder', 'cap_recorder'], {
  ...selectable(
    'interactive',
    ['idea'],
    ['screen_demo'],
    '根据用户明确录屏需求检查环境或录制真实屏幕并入库，不能伪造软件操作',
    '用户明确启用录屏并指定屏幕/时长；不得因进入流程自动读取或录制桌面',
    'capture',
  ),
  mode: 'interactive',
})
group(
  ['export_bundle'],
  defaulted(
    'delivery',
    ['publish', 'compose'],
    all,
    '将实际成片、真实字幕和来源清单打包成本地交付文件，不自动发布到外部平台',
    '成片和交付元数据均已就绪；无publish阶段的流程在compose完成后交付',
  ),
)

for (const item of inventory) if (!policies[item.id]) throw new Error(`缺少流程工具策略：${item.id}`)
for (const id of Object.keys(policies))
  if (!inventory.some((item) => item.id === id)) throw new Error(`策略引用不存在的工具：${id}`)
export const pipelineToolPolicies: Readonly<Record<string, PipelineToolPolicy>> = policies
export function getPipelineToolPolicy(toolId: string): PipelineToolPolicy | null {
  return pipelineToolPolicies[toolId] ?? null
}
export function pipelineToolPoliciesFor(category: CreativeCategory, stage?: StageKind): PipelineToolPolicy[] {
  return Object.values(pipelineToolPolicies).filter(
    (policy) => policy.categories.includes(category) && (!stage || policy.stages.includes(stage)),
  )
}
