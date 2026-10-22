/**
 * 管线 Agent 阶段值守（《重构》§6 客户端推进）——嵌入模式专用。
 *
 * 服务端 text 步不再代调模型：runner 把准备好的提示词挂到 waiting 阶段的
 * pendingAgent。本组件轮询到该状态后，经宿主 Agent 车道执行任务（模型按
 * 指令返回 {"summary","content","checks"} JSON），回交产物，管线自动续跑。
 * 认领或提交失败时清除认领标记并退避重试——版本不变 effect 不会再触发，
 * 不清标记会把 waiting 阶段永久卡死（曾复现）。
 * 独立浏览器版不渲染本组件（无宿主车道，该状态在服务端保持等待）。
 */
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { pipelineApi, pipelineQueries } from '@/entities/creative/pipeline'
import { runStudioTask } from '@/shared/studio/agent-task'
import { studioHost } from '@/shared/studio/host'

export function AgentStageWatcher({ projectId, runId, version }: { projectId: number; runId: number | null; version: number | null }) {
  const client = useQueryClient()
  const claimed = useRef<string | null>(null)

  useEffect(() => {
    if (!runId || version == null || !studioHost()?.agent) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const key = `${runId}:${version}`
    const claim = () => {
      if (cancelled || claimed.current === key) return
      claimed.current = key
      void pipelineApi.agentPending(projectId, runId).then(async pending => {
        if (cancelled || !pending) return
        try {
          const task = runStudioTask('pipeline_stage',
            `${pending.instructions}\n\n[阶段资料 JSON]\n${pending.payload}`,
            { title: `视频工厂 · 管线阶段 ${pending.stageId}` })
          if (!task) throw new Error('宿主 Agent 车道不可用')
          const reply = await task.run
          // 模型被要求只返回 JSON；容错剥掉 markdown 围栏
          const json = reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
          await pipelineApi.agentCommit(projectId, runId, version, json)
        } catch {
          // 认领/提交失败：放行重试（标记已清），退避 10 秒再认领
          claimed.current = null
          if (!cancelled) timer = setTimeout(claim, 10_000)
        } finally {
          void client.invalidateQueries({ queryKey: pipelineQueries.detail(projectId).queryKey })
        }
      }).catch(() => {
        claimed.current = null
        if (!cancelled) timer = setTimeout(claim, 10_000)
      })
    }
    claim()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [projectId, runId, version, client])

  return null
}
