/**
 * 管线 Agent 阶段值守（《重构》§6 客户端推进）——嵌入模式专用。
 *
 * 服务端 text 步不再代调模型：runner 把准备好的提示词挂到 waiting 阶段的
 * pendingAgent。本组件轮询到该状态后，经宿主 Agent 车道执行任务（模型按
 * 指令返回 {"summary","content","checks"} JSON），回交产物，管线自动续跑。
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
    const key = `${runId}:${version}`
    if (claimed.current === key) return
    let cancelled = false

    void pipelineApi.agentPending(projectId, runId).then(async pending => {
      if (cancelled || !pending) return
      claimed.current = key
      try {
        const task = runStudioTask('pipeline_stage',
          `${pending.instructions}\n\n[阶段资料 JSON]\n${pending.payload}`,
          { title: `视频工厂 · 管线阶段 ${pending.stageId}` })
        if (!task) return
        const reply = await task.run
        // 模型被要求只返回 JSON；容错剥掉 markdown 围栏
        const json = reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
        await pipelineApi.agentCommit(projectId, runId, version, json)
      } finally {
        void client.invalidateQueries({ queryKey: pipelineQueries.detail(projectId).queryKey })
      }
    }).catch(() => {})

    return () => { cancelled = true }
  }, [projectId, runId, version, client])

  return null
}
