/**
 * 最终提示词服务 — 单发模型调用版（编排外移后 bot-backend 只做单次调用）
 *
 * 生图前确保角色/场景/道具已有「最终提示词」：
 * - 角色 → 三视图（character turnaround：正面/侧面/背面）
 * - 场景 → 固定视角 + 前景/中景/后景（无人物空镜）
 * - 道具 → 白底单品静物（single product shot on pure white background）
 * 缺失时单发调文本模型创作并保存；失败返回 ''，由调用方回退到本地拼接提示词
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { runTextModel } from './text-model.js'
import { logTaskError, logTaskProgress } from '../utils/task-logger.js'

type CharacterRow = typeof schema.characters.$inferSelect
type SceneRow = typeof schema.scenes.$inferSelect
type PropRow = typeof schema.props.$inferSelect

/** 顶栏选择的文本模型/配置覆盖（不传则跟随公司文本目录默认） */
export interface PromptAgentOptions { model?: string; configId?: number }

/** 单发生成并回填最终提示词；返回提示词文本。只输出提示词本身，单段连贯描述。 */
async function generateFinalPrompt(
  kind: 'character' | 'scene' | 'prop',
  subject: { name: string; fields: Record<string, string> },
  extraRule: string,
  episodeId: number,
  opts?: PromptAgentOptions,
): Promise<string> {
  const spec = {
    character: '角色三视图（character turnaround：同一角色的正面/侧面/背面，长相、发型、体型、服装完全一致，纯色背景，全身，无文字）',
    scene: '场景固定视角（同一场景的前景/中景/后景层次，广角定机位）',
    prop: '道具白底单品静物（single product shot on pure white background，无文字无水印）',
  }[kind]
  const text = await runTextModel({
    system: `你是视频工厂的提示词工程师。根据给定素材为${kind === 'character' ? '角色' : kind === 'scene' ? '场景' : '道具'}创作一张图片的最终提示词：${spec}。${extraRule}只返回提示词本身：单段连贯英文或与素材一致的语言，不解释、不分点、不加引号。`,
    prompt: JSON.stringify(subject),
    model: opts?.model,
    correlationId: `episode-${episodeId}`,
  })
  return text.trim()
}

/** 确保角色拥有三视图最终提示词，返回最终提示词（失败返回 ''）；force 时忽略已有提示词强制重新生成 */
export async function ensureCharacterFinalPrompt(char: CharacterRow, episodeId: number, force = false, opts?: PromptAgentOptions): Promise<string> {
  if (char.finalPrompt && !force) return char.finalPrompt
  try {
    logTaskProgress('FinalPrompt', 'character-generate', { characterId: char.id, episodeId });
    const prompt = await generateFinalPrompt('character',
      { name: char.name, fields: { role: char.role, appearance: char.appearance, styling: char.styling, description: char.description } },
      '样貌与妆造必须支撑三视图一致性；性格特点转化为外在气质与神态。', episodeId, opts)
    if (!prompt) return ''
    await db.update(schema.characters).set({ finalPrompt: prompt, updatedAt: new Date().toISOString() }).where(eq(schema.characters.id, char.id))
    return prompt
  } catch (err: any) {
    logTaskError('FinalPrompt', 'character-generate', { characterId: char.id, error: err.message })
    return ''
  }
}

/** 确保场景拥有固定视角（前中后景）最终提示词，返回最终提示词（失败返回 ''）；force 时忽略已有提示词强制重新生成 */
export async function ensureSceneFinalPrompt(scene: SceneRow, episodeId: number, force = false, opts?: PromptAgentOptions): Promise<string> {
  if (scene.finalPrompt && !force) return scene.finalPrompt
  try {
    logTaskProgress('FinalPrompt', 'scene-generate', { sceneId: scene.id, episodeId });
    const prompt = await generateFinalPrompt('scene',
      { name: scene.location, fields: { time: scene.time, prompt: scene.prompt, lighting: scene.lighting } },
      '这是无人物空镜——图中不能出现任何的人（含背影、剪影、倒影、照片里的人），即使素材提到人物活动也必须剔除。', episodeId, opts)
    if (!prompt) return ''
    await db.update(schema.scenes).set({ finalPrompt: prompt, updatedAt: new Date().toISOString() }).where(eq(schema.scenes.id, scene.id))
    return prompt
  } catch (err: any) {
    logTaskError('FinalPrompt', 'scene-generate', { sceneId: scene.id, error: err.message })
    return ''
  }
}

/** 确保道具拥有白底单品最终提示词，返回最终提示词（失败返回 ''）；force 时忽略已有提示词强制重新生成 */
export async function ensurePropFinalPrompt(prop: PropRow, episodeId: number, force = false, opts?: PromptAgentOptions): Promise<string> {
  if (prop.finalPrompt && !force) return prop.finalPrompt
  try {
    logTaskProgress('FinalPrompt', 'prop-generate', { propId: prop.id, episodeId });
    const prompt = await generateFinalPrompt('prop',
      { name: prop.name, fields: { type: prop.type, description: prop.description } },
      '只描写物品本身的物理外观，不写剧情用途与人物关联。', episodeId, opts)
    if (!prompt) return ''
    await db.update(schema.props).set({ finalPrompt: prompt, updatedAt: new Date().toISOString() }).where(eq(schema.props.id, prop.id))
    return prompt
  } catch (err: any) {
    logTaskError('FinalPrompt', 'prop-generate', { propId: prop.id, error: err.message })
    return ''
  }
}
