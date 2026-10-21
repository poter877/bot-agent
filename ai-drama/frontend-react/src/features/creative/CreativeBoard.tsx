/**
 * 制片看板——OpenMontage Backlot「living storyboard」概念的对齐实现。
 *
 * 只读实况看板：剧本页卡、分镜胶片条（随素材生成逐格填充）、当前阶段
 * 聚焦、活动流、成片区。数据全部来自管线 API（PipelineState + 项目文档），
 * 运行中由管线查询的轮询自动刷新——不引入新的数据通道。
 */
import { useMemo, useState } from 'react'
import { CheckCircle2, Circle, Loader2, XCircle, Film, Play } from 'lucide-react'
import type { CreativeProject } from '@/entities/creative/model'
import { type PipelineState } from '@/entities/creative/pipeline'
import { Button } from '@/shared/ui/button'
import { cn } from '@/shared/lib/cn'

const stageTitles: Record<string, string> = {
  research: '资料研究', proposal: '方案提案', script: '脚本与讲稿', scene_plan: '分镜与时序',
  idea: '主题构思', assets: '素材制作', edit: '剪辑决策', compose: '合成与验片',
  publish: '交付打包', character_design: '角色设计', rig_plan: '绑定计划',
}
const eventText: Record<string, string> = {
  continued: '继续执行', stage_started: '开始阶段', stage_output: '阶段产出', stage_waiting: '阶段等待',
  checkpoint: '检查点保存', awaiting_agent: '等待 AI 执行', agent_committed: '阶段审阅通过',
  review_required: '进入审阅', tool_writeback_recovered: '工具写回恢复', interrupted: '服务重启暂停',
  rewound: '阶段退回', continued_failed: '继续失败', poll: '进度查询',
}

function Panel({ title, children, className, action }: { title: string; children: React.ReactNode; className?: string; action?: React.ReactNode }) {
  return (
    <section className={cn('min-w-0 rounded-panel border border-outline bg-surface p-4', className)}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-content-secondary">{title}</h3>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </section>
  )
}

export function CreativeBoard({ project, state, loading }: { project: CreativeProject; state?: PipelineState | null; loading?: boolean }) {
  const run = state?.run
  const cursor = run?.stages[run.cursor]
  const [scriptOpen, setScriptOpen] = useState(false)

  const script = useMemo(() => {
    const index = state?.definition?.stages.findIndex(s => s.id === 'script') ?? -1
    return index >= 0 ? run?.stages[index]?.artifact ?? null : null
  }, [state, run])

  const activity = useMemo(() => (state?.events ?? []).filter(e => e.kind !== 'poll').slice(-14).reverse(), [state])
  const shots = project.shots
  const lastActivity = activity[0]?.createdAt ?? run?.stages.find(s => s.status !== 'pending')?.startedAt ?? null

  const stageIcon = (status: string) =>
    status === 'completed' ? <CheckCircle2 size={13} className="text-success" aria-hidden />
      : status === 'running' || status === 'waiting' ? <Loader2 size={13} className="animate-spin text-brand-content" aria-hidden />
        : status === 'failed' ? <XCircle size={13} className="text-danger" aria-hidden />
          : status === 'review' ? <CheckCircle2 size={13} className="text-brand-content" aria-hidden />
            : <Circle size={13} className="text-content-subtle" aria-hidden />

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* Slate：项目状态牌 */}
      <Panel title="状态">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
          <span className={cn('flex items-center gap-1.5 font-semibold',
            run?.status === 'failed' ? 'text-danger' : ['running', 'waiting'].includes(run?.status ?? '') ? 'text-brand-content' : 'text-content-secondary')}>
            {loading ? <Loader2 size={13} className="animate-spin" aria-hidden />
              : run?.status === 'failed' ? <XCircle size={13} aria-hidden />
                : ['running', 'waiting'].includes(run?.status ?? '') ? <Loader2 size={13} className="animate-spin" aria-hidden />
                  : <CheckCircle2 size={13} aria-hidden />}
            {run ? (runStatusText[run.status] ?? run.status) : '未建立流程'}
          </span>
          {cursor && ['running', 'waiting', 'review'].includes(run?.status ?? '') && (
            <span className="text-content-muted">当前：{stageTitles[cursor.id] ?? cursor.id}</span>
          )}
          {lastActivity && <span className="text-content-subtle">最近活动：{new Date(lastActivity).toLocaleString()}</span>}
          {shots.length > 0 && <span className="text-content-subtle">{shots.length} 个镜头</span>}
        </div>
      </Panel>

      <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-4">
          {/* 剧本页卡 */}
          {script?.content && (
            <Panel
              title="脚本"
              action={<Button size="sm" variant="ghost" onClick={() => setScriptOpen(true)}>阅读全文</Button>}
            >
              <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-control bg-hover-overlay p-3 font-serif text-[13px] leading-relaxed text-content">{script.content.slice(0, 1200)}{script.content.length > 1200 ? '…' : ''}</pre>
              {script.checks?.length ? <ul className="mt-2 list-none space-y-0.5 p-0 text-xs text-content-muted">{script.checks.map((c, i) => <li key={i}>· {c}</li>)}</ul> : null}
            </Panel>
          )}

          {/* 分镜胶片条：随素材生成逐格填充 */}
          {shots.length > 0 && (
            <Panel title={`分镜 · ${shots.filter(s => s.imageUrl || s.videoUrl).length}/${shots.length} 已有素材`}>
              <ol className="m-0 flex list-none gap-2 overflow-x-auto p-0 pb-1">
                {shots.map((shot, i) => {
                  return (
                    <li key={shot.id} className="w-40 shrink-0">
                      <div className="relative aspect-video overflow-hidden rounded-control border border-outline bg-track">
                        {shot.videoUrl ? <video src={shot.videoUrl} className="size-full object-cover" muted /> :
                          shot.imageUrl ? <img src={shot.imageUrl} alt={shot.title} className="size-full object-cover" /> :
                            <span className="flex size-full items-center justify-center text-content-subtle">
                              {shot.imageTask || shot.videoTask ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Film size={16} aria-hidden />}
                            </span>}
                        <span className="absolute left-1 top-1 rounded-pill bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white">{String(i + 1).padStart(2, '0')}</span>
                      </div>
                      <p className="mt-1 truncate text-xs font-medium text-content-secondary" title={shot.title}>{shot.title}</p>
                      <p className="truncate text-[10px] text-content-subtle">{shot.duration}s · {shot.mediaType === 'video' ? '视频' : '图像'}</p>
                    </li>
                  )
                })}
              </ol>
            </Panel>
          )}

          {/* 成片区 */}
          {project.renders.length > 0 && (
            <Panel title="成片">
              <ol className="m-0 flex list-none flex-wrap gap-2 p-0">
                {project.renders.filter(r => r.videoUrl).map((render, i) => (
                  <li key={i}>
                    <a href={render.videoUrl ?? undefined} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded-control border border-outline px-3 py-2 text-xs text-content-secondary hover:bg-hover-overlay">
                      <Play size={12} aria-hidden />成片 {i + 1}
                    </a>
                  </li>
                ))}
              </ol>
            </Panel>
          )}
        </div>

        {/* 右栏：当前阶段聚焦 + 活动流 */}
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="当前阶段">
            {cursor ? (
              <div className="space-y-2 text-xs">
                <p className="flex items-center gap-1.5 text-sm font-semibold text-content">
                  {stageIcon(cursor.status)}
                  {stageTitles[cursor.id] ?? cursor.id}
                  <span className="text-content-subtle">· {cursor.status === 'completed' ? '已完成' : cursor.status === 'waiting' ? '等待 AI 执行' : cursor.status === 'review' ? '等待审阅' : cursor.status === 'failed' ? '失败' : '进行中'}</span>
                </p>
                {cursor.artifact?.summary && <p className="text-content-secondary">{cursor.artifact.summary}</p>}
                {cursor.error && <p className="text-danger">{cursor.error}</p>}
                {!cursor.artifact && !cursor.error && cursor.status === 'pending' && <p className="text-content-subtle">等待前序阶段完成</p>}
              </div>
            ) : <p className="text-xs text-content-subtle">尚未开始</p>}
          </Panel>

          <Panel title="活动">
            {activity.length ? (
              <ol className="m-0 max-h-80 list-none space-y-2 overflow-y-auto p-0 text-xs">
                {activity.map((event, i) => (
                  <li key={`${event.id ?? i}-${i}`} className="flex gap-2">
                    <span className="shrink-0 text-content-subtle">{new Date(event.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    <span className="min-w-0 text-content-secondary">
                      {eventText[event.kind] ?? event.kind}
                      {event.stageId ? <span className="text-content-subtle"> · {stageTitles[event.stageId] ?? event.stageId}</span> : null}
                    </span>
                  </li>
                ))}
              </ol>
            ) : <p className="text-xs text-content-subtle">暂无活动</p>}
          </Panel>
        </div>
      </div>

      {scriptOpen && script?.content && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8" onClick={() => setScriptOpen(false)}>
          <div className="max-h-full w-full max-w-3xl overflow-y-auto rounded-panel bg-surface p-6 shadow-lg" onClick={e => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-bold">脚本全文</h3>
              <Button size="sm" variant="ghost" onClick={() => setScriptOpen(false)}>关闭</Button>
            </div>
            <pre className="whitespace-pre-wrap break-words font-serif text-[13px] leading-relaxed text-content">{script.content}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

const runStatusText: Record<string, string> = {
  ready: '待开始', running: '进行中', pausing: '暂停中', paused: '已暂停', waiting: '等待 AI 执行',
  review: '等待审阅', failed: '已失败', completed: '已完成', cancelled: '已结束',
}
