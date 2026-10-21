/**
 * 对话内阶段审阅卡——《重构》§6 对话式制片的审阅面。
 *
 * 制作流程 Tab 移除后，阶段审阅收敛到制作对话：流程中出现「待审阅」阶段时，
 * 对话流里出现该阶段的产物卡片（摘要+全文+检查事项），确认按钮直接调
 * approve 接口；需要修改时用户在对话里说明，Agent 经 MCP 工具改方案，
 * 项目 revision 变化触发 stale→同步流程。
 * 卡片由管线状态派生渲染（非追加消息），刷新/切 Tab 不重复、不丢失。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { pipelineApi, pipelineQueries, type PipelineState } from '@/entities/creative/pipeline'
import { Button } from '@/shared/ui/button'

const stageTitles: Record<string, string> = {
  research: '资料研究', proposal: '方案提案', script: '脚本与讲稿', scene_plan: '分镜与时序',
  idea: '主题构思', assets: '素材制作', edit: '剪辑决策', compose: '合成与验片',
  publish: '交付打包', character_design: '角色设计', rig_plan: '绑定计划',
}

export function PipelineReviewCards({ project, state }: { project: { id: number }; state?: PipelineState | null }) {
  const client = useQueryClient()
  const run = state?.run
  const reviewStage = run?.stages.find(stage => stage.status === 'review')
  const definitionStage = reviewStage ? state?.definition?.stages.find(stage => stage.id === reviewStage.id) : undefined
  const title = reviewStage ? (definitionStage?.title ?? stageTitles[reviewStage.id] ?? reviewStage.id) : ''

  const approve = useMutation({
    mutationFn: () => {
      if (!run) { throw new Error('流程不存在') }
      return pipelineApi.action(project.id, run.id, { action: 'approve', version: run.version })
    },
    onSuccess: async (result) => {
      await client.cancelQueries({ queryKey: pipelineQueries.detail(project.id).queryKey })
      client.setQueryData(pipelineQueries.detail(project.id).queryKey, result)
    },
    onError: () => { void client.invalidateQueries({ queryKey: pipelineQueries.detail(project.id).queryKey }) },
  })

  if (!run || !reviewStage) { return null }
  const artifact = reviewStage.artifact

  return (
    <article className="mr-2 rounded-xl border border-outline bg-surface p-3 text-sm" aria-label={`待审阅：${title}`}>
      <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-brand-content">
        <CheckCircle2 size={13} aria-hidden />{title}已完成，等待确认
      </div>
      {artifact?.summary && <p className="mb-1.5 text-xs font-semibold text-content-secondary">{artifact.summary}</p>}
      {artifact?.content && (
        <div className="mb-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-control bg-hover-overlay p-2.5 text-xs leading-relaxed text-content">{artifact.content}</div>
      )}
      {artifact?.checks?.length ? (
        <ul className="mb-2 list-none space-y-0.5 p-0 text-xs text-content-muted">
          {artifact.checks.map((check, i) => <li key={i}>· {check}</li>)}
        </ul>
      ) : null}
      <Button size="sm" variant="primary" loading={approve.isPending} onClick={() => approve.mutate()}>
        {approve.isPending ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <CheckCircle2 size={12} aria-hidden />}
        确认此阶段
      </Button>
      <span className="ml-2 text-[11px] text-content-subtle">如需修改，直接在下方输入修改要求</span>
    </article>
  )
}
