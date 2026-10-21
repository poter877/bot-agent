/**
 * 制作流程条——项目工作台顶部常显（《重构》对齐 OpenMontage 的对话式制片）。
 *
 * 进入项目第一眼看到流程：阶段进度 + 当前运行状态 + 建立/继续/重试快捷操作；
 * 点击阶段切到制作流程视图看详情。编辑器各 Tab 下也保持可见，流程状态不丢。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Circle, Loader2, Play, XCircle } from 'lucide-react'
import { pipelineApi, pipelineQueries, type PipelineState } from '@/entities/creative/pipeline'
import { Button } from '@/shared/ui/button'
import { cn } from '@/shared/lib/cn'

const stageTitles: Record<string, string> = {
  research: '资料研究', proposal: '方案提案', script: '脚本与讲稿', scene_plan: '分镜与时序',
  idea: '主题构思', assets: '素材制作', edit: '剪辑决策', compose: '合成与验片',
  publish: '交付打包', character_design: '角色设计', rig_plan: '绑定计划',
}
const statusIcon = (status: string) =>
  status === 'completed' ? CheckCircle2
    : status === 'running' ? Loader2
      : status === 'failed' ? XCircle
        : status === 'review' ? CheckCircle2
          : Circle

const runStatusText: Record<string, string> = {
  ready: '待开始', running: '进行中', pausing: '暂停中', paused: '已暂停', waiting: '等待 AI 执行',
  review: '等待审阅', failed: '已失败', completed: '已完成', cancelled: '已结束',
}

export function PipelineStrip({ project, state, loading, disabled, activeStage, onOpenPipeline, onSelectStage }: {
  project: { id: number; revision: number; category: string }
  state?: PipelineState | null
  loading?: boolean
  disabled?: boolean
  /** 当前工作台所处 Tab——处于流程视图时隐藏冗余的「查看详情」 */
  activeStage?: string
  onOpenPipeline: () => void
  /** 点击阶段 chip：切到流程视图并打开该阶段详情 */
  onSelectStage: (stageId: string) => void
}) {
  const client = useQueryClient()
  const run = state?.run
  const definition = state?.definition
  const ended = !!run && ['completed', 'cancelled'].includes(run.status)
  const cursor = run?.stages[run.cursor]
  const running = run?.status === 'running' || run?.status === 'pausing'

  const action = useMutation({
    mutationFn: (input: 'start' | 'continue' | 'retry') => {
      if (input === 'start' || !run) return pipelineApi.start(project.id, project.revision)
      return pipelineApi.action(project.id, run.id, { action: input, version: run.version })
    },
    onSuccess: async (result) => {
      await client.cancelQueries({ queryKey: pipelineQueries.detail(project.id).queryKey })
      client.setQueryData(pipelineQueries.detail(project.id).queryKey, result)
    },
    onError: () => { void client.invalidateQueries({ queryKey: pipelineQueries.detail(project.id).queryKey }) },
  })

  const failed = run?.status === 'failed' || cursor?.status === 'failed'
  // 一个项目只有一条流程：已结束/已完成后不提供「建立新一轮」
  const nextAction: 'start' | 'continue' | 'retry' | null =
    !run ? 'start'
      : ended ? null
        : !running && run.status !== 'review' && !run.stale ? (failed ? 'retry' : 'continue')
          : null

  return (
    <section aria-label="制作流程" className="mb-4 rounded-panel border border-outline bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('flex items-center gap-1.5 text-xs font-semibold', failed ? 'text-danger' : running ? 'text-brand-content' : 'text-content-secondary')}>
          {loading ? <Loader2 size={13} className="animate-spin" aria-hidden />
            : failed ? <XCircle size={13} aria-hidden />
              : running ? <Loader2 size={13} className="animate-spin" aria-hidden />
                : run?.status === 'completed' ? <CheckCircle2 size={13} className="text-success" aria-hidden />
                  : <Play size={12} aria-hidden />}
          {loading ? '流程加载中…' : run ? runStatusText[run.status] ?? run.status : '未建立流程'}
        </span>
        {cursor && run && ['running', 'waiting', 'pausing', 'review'].includes(run.status) && <span className="text-xs text-content-muted">当前：{stageTitles[cursor.id] ?? cursor.id}{cursor.status === 'waiting' ? '（等待 AI 执行）' : ''}</span>}
        <span className="ml-auto flex items-center gap-2">
          {nextAction && (
            <Button
              size="sm"
              variant={nextAction === 'start' ? 'primary' : 'default'}
              disabled={disabled}
              loading={action.isPending}
              onClick={() => action.mutate(nextAction)}
            >
              <Play size={12} aria-hidden />
              {nextAction === 'start' ? (run ? '建立新一轮流程' : '建立制作流程') : failed ? '重试当前阶段' : '继续执行'}
            </Button>
          )}
          {activeStage !== 'pipeline' && (
            <Button size="sm" variant="ghost" onClick={onOpenPipeline}>
              {run ? '查看详情' : '打开流程'}
            </Button>
          )}
        </span>
      </div>
      {definition && (
        <ol className="m-0 mt-2.5 flex list-none flex-wrap items-center gap-x-1 gap-y-1.5 p-0">
          {definition.stages.map((stage, index) => {
            const record = run?.stages[index]
            const status = record?.status ?? 'pending'
            const Icon = statusIcon(status)
            const isCursor = run && index === run.cursor
            return (
              <li key={stage.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onSelectStage(stage.id)}
                  title={`${stageTitles[stage.id] ?? stage.id} · ${
                    status === 'completed' ? '已完成' : status === 'running' ? '进行中' : status === 'failed' ? '失败'
                      : status === 'review' ? '待审阅' : status === 'waiting' ? '等待 AI' : '未开始'}`}
                  className={cn(
                    'flex items-center gap-1 rounded-pill border-0 px-2 py-1 text-[11px] font-medium focus-visible:outline-none focus-visible:shadow-focus',
                    isCursor ? 'bg-brand-soft text-brand-content'
                      : status === 'failed' ? 'bg-danger-soft text-danger'
                        : status === 'completed' ? 'bg-track text-content-secondary'
                          : 'bg-transparent text-content-subtle hover:bg-hover-overlay',
                  )}
                >
                  <Icon size={11} className={status === 'running' ? 'animate-spin' : ''} aria-hidden />
                  {String(index + 1).padStart(2, '0')} {stageTitles[stage.id] ?? stage.title ?? stage.id}
                </button>
                {index < definition.stages.length - 1 && <span className="text-content-subtle" aria-hidden>·</span>}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
