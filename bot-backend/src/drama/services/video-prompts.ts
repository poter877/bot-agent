/**
 * 批量视频提示词任务 — 单发模型调用版（编排外移后 bot-backend 只做单次调用）
 *
 * 异步为缺少 video_prompt 的分镜逐个单发生成并直接落库；
 * 进程内内存态：按集跟踪一份任务，运行中不重复启动；重启后状态丢失
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { runTextModel } from './text-model.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

export interface VideoPromptBatchStatus {
  status: 'running' | 'done' | 'error'
  total: number
  completed: number
  failed: number
  current_storyboard_id?: number
  started_at: string
  finished_at?: string
  error?: string
}

const tasks = new Map<number, VideoPromptBatchStatus>()

/** 启动批量生成（立即返回）；运行中返回 started:false,total:-1；无待生成分镜返回 started:false,total:0；
 *  传入 storyboardIds 时只处理所选分镜（即使已有提示词也重新生成），否则处理全部缺失提示词的分镜 */
export async function startVideoPromptBatch(
  episodeId: number,
  dramaId: number,
  opts: { model?: string; configId?: number } = {},
  storyboardIds?: number[],
): Promise<{ started: boolean; total: number }> {
  if (tasks.get(episodeId)?.status === 'running') return { started: false, total: -1 }

  const sbs = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
  const pending = storyboardIds?.length
    ? sbs.filter(sb => storyboardIds.includes(sb.id))
    : sbs.filter(sb => !(sb.videoPrompt || '').trim())
  if (!pending.length) return { started: false, total: 0 }

  // 视频模型标签：跟随该集锁定的视频配置，供模型按该模型特性生成
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  let videoLabel = '默认'
  if (ep?.videoConfigId) {
    const [cfg] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, ep.videoConfigId))
    if (cfg) videoLabel = `${cfg.name} (${cfg.provider})`
  }

  const task: VideoPromptBatchStatus = {
    status: 'running',
    total: pending.length,
    completed: 0,
    failed: 0,
    started_at: new Date().toISOString(),
  }
  tasks.set(episodeId, task)

  logTaskStart('VideoPrompt', 'batch', { episodeId, dramaId, total: pending.length, model: opts.model || undefined })
  ;(async () => {
    for (const sb of pending) {
      task.current_storyboard_id = sb.id
      logTaskProgress('VideoPrompt', 'batch-shot', { episodeId, storyboardId: sb.id, index: task.completed + task.failed + 1, total: task.total })
      try {
        const raw = await runTextModel({
          system: `你是视频工厂的视频提示词工程师。根据输入分镜的 description（含【镜头N】子镜头与台词/旁白）、atmosphere、duration 与视频模型特性生成 video_prompt：
第一行是信息头：列出该分镜出场的人物与场景，用 @角色名/@场景名 引用；之后按 3 秒一段、每段单独一行换行分隔，description 的每个【镜头N】映射为 1-2 个连续 3 秒段（顺序一致、不遗漏、不新增子镜头），台词/旁白从对应【镜头N】内提取，不创作之外的新台词；提到场景用 @场景名、角色用 @角色名、道具用 @道具名（名字必须与输入列表完全一致）；氛围光线取自 atmosphere。段落内允许多镜头切镜，段与段可以是不同景别/角度/对象，但不跨场景；切镜点对齐【镜头N】结构。
只返回 video_prompt 本身，不要解释。视频模型：${videoLabel}，按该模型的特性与时长限制（总时长 ${sb.duration} 秒）调整写法。`,
          prompt: JSON.stringify({
            storyboard: {
              id: sb.id,
              number: sb.storyboardNumber,
              title: sb.title,
              description: sb.description,
              atmosphere: sb.atmosphere,
              duration: sb.duration,
            },
          }),
          model: opts.model,
          correlationId: `episode-${episodeId}`,
        })
        const prompt = raw.trim()
        if (!prompt) throw new Error('模型返回空提示词')
        await db.update(schema.storyboards)
          .set({ videoPrompt: prompt, updatedAt: new Date().toISOString() })
          .where(eq(schema.storyboards.id, sb.id))
        task.completed++
      } catch (err: any) {
        task.failed++
        logTaskError('VideoPrompt', 'batch-shot', { storyboardId: sb.id, error: err?.message })
      }
    }
  })()
    .then(() => {
      task.status = 'done'
      task.finished_at = new Date().toISOString()
      task.current_storyboard_id = undefined
      logTaskSuccess('VideoPrompt', 'batch', { episodeId, total: task.total, completed: task.completed, failed: task.failed })
    })
    .catch((err: any) => {
      task.status = 'error'
      task.finished_at = new Date().toISOString()
      task.error = err?.message || '批量生成失败'
      logTaskError('VideoPrompt', 'batch', { episodeId, error: err?.message })
    })
  return { started: true, total: pending.length }
}

export function getVideoPromptBatchStatus(episodeId: number): VideoPromptBatchStatus | null {
  return tasks.get(episodeId) || null
}
