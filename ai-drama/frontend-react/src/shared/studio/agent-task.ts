/**
 * 一次性创作任务（宿主车道）——《重构》方案 §4/§6 的客户端推进器。
 *
 * 每次任务一个独立宿主会话：发送「任务指令 + 用户消息」，等 message.complete
 * （或失败/停止）后回调。模型经 MCP 工具读写领域数据；调用方随后刷新业务
 * 快照。旧的 bot-backend 代调（/agent/:type/chat、/creative/:id/plan）在嵌入
 * 模式下由本模块取代。
 */
import { studioHost } from './host'

export interface StudioTaskHandle {
  /** 任务回合结束（完成/失败/打断）resolve；文本为助手最终回复。 */
  run: Promise<string>
  stop: () => void
}

/** 每类任务的指令前缀（领域细则由产品 skill 承载，这里只定任务边界）。 */
export const TASK_INSTRUCTIONS: Record<string, string> = {
  script_rewriter:
    '【任务：剧本改写】先用工具读取本集剧本与上下文，改写为格式化剧本（场次/角色/对白/旁白），改完用 save_script 保存，最后用两三句话汇报改动。',
  storyboard_breaker:
    '【任务：分镜拆解】先读取本集剧本与分镜上下文，按场次拆分镜头（画面描述、景别/运镜、时长），用 save_storyboards 落库，最后汇报镜头数与要点。',
  creative_plan:
    '【任务：生成创意方案】用 read_creative_project 读取当前项目（brief 与现有方案），产出完整方案：plan.summary / plan.script / plan.musicDirection 与 shots 分镜清单（画面描述、时长），用 save_creative_plan 整体保存（带读到的 revision），最后汇报方案要点。',
  creative_translate:
    '【任务：小说转方案】用 read_creative_project 读取当前项目与 brief.idea 中的原文，将其转写为视频方案（summary/script/shots），用 save_creative_plan 整体保存，最后汇报。',
}

export function runStudioTask(
  kind: keyof typeof TASK_INSTRUCTIONS | string,
  message: string,
  opts?: { title?: string; timeoutMs?: number },
): StudioTaskHandle | null {
  const agent = studioHost()?.agent
  if (!agent) return null
  const instruction = TASK_INSTRUCTIONS[kind] ?? `【任务：${kind}】`
  let sessionId: string | null = null

  const run = (async () => {
    const session = await agent.createSession({
      title: opts?.title ?? `视频工厂 · ${kind}`,
      idempotencyKey: `studio-task-${kind}-${Date.now()}`
    })
    sessionId = session.sessionId
    const deadline = opts?.timeoutMs ?? 600_000

    return await new Promise<string>(resolve => {
      const off = agent.onEvent(event => {
        if (event.sessionId !== session.sessionId) return

        if (event.type === 'message.complete') {
          off()
          clearTimeout(timer)
          const payload = (event.payload ?? {}) as Record<string, unknown>
          resolve(String(payload.text ?? payload.content ?? ''))
        }
      })
      const timer = setTimeout(() => {
        off()
        resolve('')
      }, deadline)

      void agent.submit(session.sessionId, `${instruction}\n\n${message}`).catch(() => {
        off()
        clearTimeout(timer)
        resolve('')
      })
    })
  })()

  return {
    run,
    stop: () => {
      if (sessionId) void agent.interrupt(sessionId)
    }
  }
}
