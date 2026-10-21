/**
 * 模式工具包——《重构》对齐 OpenMontage pipeline_defs 的 tools_available。
 *
 * 每个制作模式只放行自己的工具子集（对照其 12 条管线，含公共核心+模式专属），
 * 工具目录与专项面板按项目品类收敛，不再全量 150 项。选择器
 * （image_selector/video_selector/tts_selector/music_gen 等）在目录层展开为
 * 同 serviceType 的供应商全族：模式限制的是能力位，供应商是能力下的选择。
 */
import type { CreativeCategory } from '../creative-catalog.js'

const kits: Partial<Record<CreativeCategory, readonly string[]>> = {
  // 科普解说（对照 animated-explainer）：生成型，图解/代码/数学动画为主
  explainer: ['image_selector', 'video_selector', 'tts_selector', 'music_gen', 'diagram_gen', 'code_snippet', 'math_animate', 'audio_mixer', 'video_compose', 'hyperframes_compose', 'video_stitch', 'export_bundle'],
  // 电影感短片（对照 cinematic 23 个）
  cinematic: ['image_selector', 'video_selector', 'tts_selector', 'music_gen', 'audio_enhance', 'audio_mixer', 'color_grade', 'frame_sampler', 'scene_detect', 'transcriber', 'subtitle_gen', 'video_trimmer', 'video_compose', 'video_stitch', 'hyperframes_compose', 'atlas_3d', 'fal_3d', 'threejs_world', 'blender_world', 'threejs_asset_catalog', 'freesound_music', 'pixabay_music', 'bgm_montage_lite', 'export_bundle'],
  // 动态图形（对照 animation 18 个）
  animation: ['image_selector', 'video_selector', 'tts_selector', 'music_gen', 'audio_mixer', 'diagram_gen', 'math_animate', 'code_snippet', 'transcriber', 'video_compose', 'video_stitch', 'hyperframes_compose', 'atlas_3d', 'fal_3d', 'threejs_world', 'blender_world', 'threejs_asset_catalog', 'fal_elevenlabs_music', 'export_bundle'],
  // 角色动画（对照 character-animation：绑定流水线一族）
  character_animation: ['image_selector', 'tts_selector', 'transcriber', 'music_gen', 'audio_mixer', 'video_compose', 'character_rig_renderer', 'showcase_card', 'diagram_gen', 'export_bundle'],
  // 纪录片（对照 documentary-montage：语料库+素材检索）
  documentary: ['transcriber', 'music_gen', 'audio_mixer', 'color_grade', 'video_trimmer', 'video_compose', 'video_stitch', 'clip_search', 'direct_clip_search', 'archive_org', 'wikimedia', 'nasa', 'noaa', 'esa', 'jaxa', 'loc', 'export_bundle'],
  // 实拍混合（对照 hybrid 17 个）
  hybrid: ['image_selector', 'video_selector', 'tts_selector', 'transcriber', 'music_gen', 'audio_enhance', 'audio_mixer', 'color_grade', 'diagram_gen', 'frame_sampler', 'scene_detect', 'subtitle_gen', 'video_trimmer', 'video_compose', 'video_stitch', 'hyperframes_compose', 'export_bundle'],
  // 真人口播（对照 talking-head：修人+剪辑）
  talking_head: ['transcriber', 'tts_selector', 'audio_enhance', 'audio_mixer', 'color_grade', 'auto_reframe', 'silence_cutter', 'face_enhance', 'face_restore', 'face_tracker', 'frame_sampler', 'scene_detect', 'subtitle_gen', 'remotion_caption_burn', 'video_trimmer', 'video_compose', 'video_stitch', 'image_selector', 'visual_qa', 'export_bundle'],
  // 数字人讲解（对照 avatar-spokesperson）
  avatar: ['talking_head', 'heygen_avatar', 'lip_sync', 'transcriber', 'tts_selector', 'audio_enhance', 'audio_mixer', 'image_selector', 'subtitle_gen', 'video_compose', 'video_stitch', 'export_bundle'],
  // 软件演示（对照 screen-demo）
  screen_demo: ['transcriber', 'tts_selector', 'audio_enhance', 'audio_mixer', 'diagram_gen', 'frame_sampler', 'scene_detect', 'subtitle_gen', 'image_selector', 'hyperframes_compose', 'video_compose', 'video_trimmer', 'export_bundle'],
  // 播客转视频（对照 podcast-repurpose）
  podcast: ['transcriber', 'tts_selector', 'audio_enhance', 'audio_mixer', 'diagram_gen', 'frame_sampler', 'image_selector', 'music_gen', 'subtitle_gen', 'video_compose', 'video_trimmer', 'export_bundle'],
  // 批量切片（对照 clip-factory）
  clip_factory: ['transcriber', 'audio_enhance', 'audio_mixer', 'color_grade', 'frame_sampler', 'scene_detect', 'subtitle_gen', 'video_compose', 'video_trimmer', 'export_bundle'],
  // 字幕翻译配音（对照 localization-dub）
  localization: ['transcriber', 'tts_selector', 'audio_enhance', 'audio_mixer', 'frame_sampler', 'scene_detect', 'subtitle_gen', 'lip_sync', 'video_compose', 'video_trimmer', 'export_bundle'],
}

/** 模式未定义工具包时（遗留品类）返回 null —— 调用方回落全量。 */
export function modeToolKit(category: string): readonly string[] | null {
  return kits[category as CreativeCategory] ?? null
}

/** 目录层过滤：kit 中的选择器 id 展开为同 serviceType 供应商全族。 */
export function toolMatchesKit(tool: { id: string; serviceType?: string | null }, kit: readonly string[], kitServiceTypes: ReadonlySet<string>): boolean {
  if (kit.includes(tool.id)) return true
  // 选择器展开：kit 里声明了 *_selector（或 music_gen 这类族首），其 serviceType 全族放行
  return !!tool.serviceType && kitServiceTypes.has(tool.serviceType)
}
