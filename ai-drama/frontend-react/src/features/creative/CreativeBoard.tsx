/**
 * 制片看板——OpenMontage Backlot「living storyboard」的对齐实现。
 *
 * 胶片美学：片孔点阵分隔、奶油剧本纸（APPROVED 戳）、琥珀现场态、
 * 场景卡按时长变宽、元数据 chips、斜体旁白、LIVE 呼吸灯。
 * 数据全部来自管线 API 与项目文档，运行中由管线查询轮询自动刷新。
 * 只读看板——流程建立在制作对话（EP 经 pipeline_start），审阅确认在对话审阅卡。
 */
import { useMemo, useState } from 'react'
import { Loader2, Play, Volume2 } from 'lucide-react'
import type { CreativeProject, CreativeShot } from '@/entities/creative/model'
import { type PipelineState } from '@/entities/creative/pipeline'
import { Button } from '@/shared/ui/button'
import { cn } from '@/shared/lib/cn'

const stageNames: Record<string, string> = {
  research: 'research', proposal: 'proposal', script: 'script', scene_plan: 'scene_plan',
  idea: 'idea', assets: 'assets', edit: 'edit', compose: 'compose',
  publish: 'publish', character_design: 'character_design', rig_plan: 'rig_plan',
}
const runStatusText: Record<string, string> = {
  ready: '待开始', running: 'LIVE', pausing: '暂停中', paused: '已暂停', waiting: '等待 AI 执行',
  review: '等待审阅', failed: '已失败', completed: '已完成', cancelled: '已结束',
}
const eventText: Record<string, string> = {
  continued: '继续执行', stage_started: '开始阶段', stage_output: '阶段产出', stage_waiting: '阶段等待',
  checkpoint: '检查点保存', awaiting_agent: '等待 AI 执行', agent_committed: '阶段审阅通过',
  review_required: '进入审阅', tool_writeback_recovered: '工具写回恢复', interrupted: '服务重启暂停',
  rewound: '阶段退回', created: '流程建立', cancelled: '流程结束',
}

const fmtDur = (sec: number) => {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const fmtClock = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''

/** 片孔点阵分隔（胶片齿孔意象） */
function Sprockets() {
  return (
    <div className="flex items-center gap-1.5 overflow-hidden opacity-25" aria-hidden>
      {Array.from({ length: 100 }, (_, i) => (
        <span key={i} className="size-1.5 shrink-0 rounded-[2px] bg-content-subtle" />
      ))}
    </div>
  )
}

export function CreativeBoard({ project, state, loading, disabled, onAction }: {
  project: CreativeProject
  state?: PipelineState | null
  loading?: boolean
  disabled?: boolean
  onAction: (action: 'continue' | 'retry' | 'sync') => void
}) {
  const [scriptExpanded, setScriptExpanded] = useState(false)
  const run = state?.run
  const stages = state?.definition?.stages ?? []
  const ended = !!run && ['completed', 'cancelled'].includes(run.status)
  const running = run?.status === 'running'
  const active = ['running', 'waiting', 'pausing'].includes(run?.status ?? '')
  const cursor = run && !ended ? run.stages[run.cursor] : undefined
  const failed = run?.status === 'failed' || cursor?.status === 'failed'
  const shots = project.shots
  const totalDuration = shots.reduce((sum, s) => sum + (Number(s.duration) || 0), 0)
  const activity = useMemo(
    () => (state?.events ?? []).filter(e => e.kind !== 'poll').slice(-12).reverse(),
    [state],
  )

  const scriptRecord = (() => {
    const index = stages.findIndex(s => s.id === 'script')
    return index >= 0 ? run?.stages[index] : undefined
  })()
  const scriptPaper = scriptRecord?.artifact?.content

  const nextAction: 'continue' | 'retry' | 'sync' | null =
    !run ? null
      : ended ? null
        : run.stale && !running ? 'sync'
          : !running && run.status !== 'review' ? (failed ? 'retry' : 'continue')
            : null

  return (
    <div className="flex min-w-0 flex-col gap-4 font-mono">
      {/* Slate */}
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="min-w-0">
          <p className="m-0 text-[10px] uppercase tracking-[0.35em] text-content-subtle">Production Board</p>
        </div>
        <span className="mb-0.5 rounded-pill border border-outline px-2.5 py-1 text-[11px] text-content-secondary">{shots.length} 镜头 · {fmtDur(totalDuration)}</span>
        <span className="ml-auto mb-0.5 flex items-center gap-3">
          {active && (
            <span className="flex items-center gap-1.5 text-xs font-bold tracking-widest text-amber-500">
              <span className="size-2 animate-pulse rounded-full bg-amber-500" aria-hidden />LIVE
            </span>
          )}
          {!active && run && (
            <span className={cn('text-xs font-semibold', run.status === 'failed' ? 'text-danger' : 'text-content-secondary')}>
              {runStatusText[run.status] ?? run.status}
            </span>
          )}
          {!run && <span className="text-[11px] text-content-subtle">流程未建立 · 在下方制作对话中说「开始制作」</span>}
          {nextAction === 'retry' && <Button size="sm" variant="primary" disabled={disabled} loading={loading} onClick={() => onAction('retry')}>重试当前阶段</Button>}
          {nextAction === 'continue' && <Button size="sm" variant="primary" disabled={disabled} loading={loading} onClick={() => onAction('continue')}>继续执行</Button>}
          {nextAction === 'sync' && <Button size="sm" disabled={disabled} onClick={() => onAction('sync')}>同步修改</Button>}
        </span>
      </div>

      {/* 阶段轨 */}
      <ol className="relative m-0 flex list-none items-start gap-1 overflow-x-auto p-0">
        <div className="absolute left-0 right-0 top-[13px] h-px bg-outline" aria-hidden />
        {stages.map((stage, i) => {
          const record = run?.stages[i]
          const status = record?.status ?? 'pending'
          const isCursor = !!run && !ended && i === run.cursor
          const label = stageNames[stage.id] ?? stage.title ?? stage.id
          return (
            <li key={stage.id} className="relative flex min-w-[86px] flex-1 flex-col items-center gap-0.5 text-center">
              <span className={cn(
                'z-10 flex size-[26px] items-center justify-center rounded-full border text-[11px]',
                isCursor ? 'border-amber-500 bg-[#1a1408] text-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.12)]'
                  : status === 'completed' || record?.status === 'completed' ? 'border-[#4a7d5d] bg-[#12241a] text-[#6fbf8f]'
                    : status === 'failed' ? 'border-danger/60 bg-danger/10 text-danger'
                      : 'border-outline bg-surface text-content-subtle',
              )}>
                {status === 'completed' || record?.status === 'completed' ? '✓'
                  : status === 'failed' ? '✕'
                    : isCursor && ['running', 'waiting'].includes(record?.status ?? '') ? <Loader2 size={12} className="animate-spin" aria-hidden />
                      : i + 1}
              </span>
              <span className={cn('font-mono text-[11px]', isCursor ? 'font-semibold text-amber-500' : record?.status === 'completed' ? 'text-content-secondary' : 'text-content-subtle')}>
                {label}
              </span>
              <span className="font-mono text-[9px] text-content-subtle">
                {record?.status === 'review' ? '审阅'
                  : record?.status === 'failed' ? `尝试 ${record.attempt}`
                    : record?.status === 'completed' ? `${fmtClock(record.completedAt)} · approved`
                      : fmtClock(record?.startedAt || record?.completedAt)}
              </span>
            </li>
          )
        })}
      </ol>

      {/* 回放条（视觉占位：回放需事件时间轴重放，后续接入） */}
      <div className="flex items-center justify-end rounded-control border border-outline/60 bg-surface px-3 py-2">
        <span className="mr-auto text-[11px] text-content-subtle">scrub the whole run</span>
        <span className="flex items-center gap-1.5 rounded-pill border border-outline px-3 py-1 text-[11px] text-content-secondary">
          <Play size={11} aria-hidden />REPLAY RUN
        </span>
      </div>

      <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-3">
          {/* 剧本纸 */}
          {scriptPaper && (
            <section className="relative rounded-[3px] bg-[#f2ecdc] p-6 text-[#3a3527] shadow-[0_10px_36px_rgba(0,0,0,0.5)]">
              {scriptRecord?.status === 'completed' && (
                <span className="absolute right-6 top-5 rotate-[8deg] rounded-[3px] border-2 border-[#4a7d5d] px-2 py-0.5 text-[11px] font-bold uppercase tracking-widest text-[#4a7d5d]">Approved</span>
              )}
              <h3 className="m-0 text-center font-serif text-lg font-bold tracking-wide">{project.title}</h3>
              <p className="mt-1 text-center font-mono text-[10px] text-[#6b6353]">script · {fmtClock(scriptRecord?.completedAt)}</p>
              <div className={cn('mt-4 space-y-3 overflow-hidden font-mono text-[12px] leading-relaxed', !scriptExpanded && 'max-h-72')}>
                {scriptPaper.split(/\n{2,}/).filter(p => p.trim()).map((para, i) => (
                  <p key={i} className="m-0 whitespace-pre-wrap break-words">{para}</p>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setScriptExpanded(v => !v)}
                className="mt-3 flex w-full items-center justify-end gap-1 border-0 bg-transparent p-0 font-mono text-[11px] font-semibold text-[#6b6353] cursor-pointer"
              >
                {scriptExpanded ? '收起' : '⤢ 展开全文'}
              </button>
            </section>
          )}

          {/* 分镜胶片条 */}
          <section className="min-w-0">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="m-0 text-xs font-semibold tracking-widest text-content-secondary">STORYBOARD</h3>
              <span className="text-[10px] text-content-subtle">{shots.length} SCENES · {fmtDur(totalDuration)} · 卡宽 ∝ 时长</span>
            </div>
            <Sprockets />
            <ol className="m-0 flex list-none items-stretch gap-2 overflow-x-auto p-1">
              {shots.map((shot, i) => <SceneCard key={shot.id} shot={shot} index={i} start={starts_of(shots)[i]} />)}
              {!shots.length && (
                <li className="rounded-[3px] border border-dashed border-outline-strong p-6 text-xs text-content-subtle">
                  分镜方案确认后，镜头卡在这里逐格填充
                </li>
              )}
            </ol>
            <Sprockets />
          </section>

          {/* 成片区 */}
          <RendersSection project={project} />
        </div>

        {/* 活动流 */}
        <aside className="min-w-0 rounded-panel border border-outline bg-surface p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="m-0 text-xs font-semibold tracking-widest text-content-secondary">活动</h3>
            <span className="text-[10px] text-content-subtle">events</span>
          </div>
          {activity.length ? (
            <ol className="m-0 max-h-[420px] list-none space-y-2.5 overflow-y-auto p-0 text-xs">
              {activity.map((event, i) => (
                <li key={`${event.id ?? 'e'}-${i}`} className="flex gap-2">
                  <span className="shrink-0 text-content-subtle">{fmtClock(event.createdAt)}</span>
                  <span className="min-w-0 text-content-secondary">
                    {eventText[event.kind] ?? event.kind}
                    {event.stageId ? <span className="text-content-subtle"> · {stageNames[event.stageId] ?? event.stageId}</span> : null}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-content-subtle">暂无活动</p>
          )}
        </aside>
      </div>
    </div>
  )
}

function starts_of(shots: CreativeShot[]) {
  let acc = 0
  return shots.map(s => { const v = acc; acc += Number(s.duration) || 0; return v })
}

function SceneCard({ shot, index, start }: { shot: CreativeShot; index: number; start: number }) {
  const generating = !!(shot.imageTask || shot.videoTask) &&
    ['queued', 'running', 'pending', 'processing'].includes((shot.imageTask ?? shot.videoTask)?.status ?? '')
  const hasMedia = !!(shot.imageUrl || shot.videoUrl)
  return (
    <li
      className={cn(
        'flex min-w-0 flex-col gap-1.5 rounded-[3px] border p-2',
        generating ? 'border-amber-500/50 bg-amber-500/5' : hasMedia ? 'border-outline bg-surface' : 'border-dashed border-outline-strong bg-transparent',
      )}
      style={{ flexGrow: Math.max(0.5, Math.min(4, Number(shot.duration) || 5)), flexBasis: 190 }}
    >
      <div className="flex items-center justify-between font-mono text-[10px] text-content-subtle">
        <span>SC {String(index + 1).padStart(2, '0')}</span>
        <span>{fmtDur(start)} – {fmtDur(start + (Number(shot.duration) || 0))}</span>
      </div>
      <div className="relative aspect-video overflow-hidden rounded-[3px] border border-outline/60 bg-track">
        {shot.videoUrl ? <video src={shot.videoUrl} className="size-full object-cover" muted /> :
          shot.imageUrl ? <img src={shot.imageUrl} alt={shot.title} className="size-full object-cover" /> :
            generating ? (
              <span className="flex size-full flex-col items-center justify-center gap-1 text-amber-500">
                <Loader2 size={14} className="animate-spin" aria-hidden />
                <span className="font-mono text-[10px] font-semibold">GENERATING</span>
                <span className="font-mono text-[9px] opacity-70">{shot.imageTask ? 'image_gen' : 'video'}</span>
              </span>
            ) : (
              <span className="flex size-full flex-col items-center justify-center gap-1 p-2 text-center">
                <span className="text-[10px] text-content-subtle">no asset yet</span>
                <span className="line-clamp-2 font-serif text-[11px] italic text-content-secondary">{shot.title}</span>
              </span>
            )}
      </div>
      <div className="flex flex-wrap gap-1 font-mono text-[9px] text-content-subtle">
        <span className="rounded-[2px] border border-outline px-1 py-px">{shot.mediaType === 'video' ? '视频' : '图像'}</span>
        {shot.audioUrl && (
          <span className="flex items-center gap-0.5 rounded-[2px] border border-outline px-1 py-px">
            <Volume2 size={8} aria-hidden />已配音
          </span>
        )}
      </div>
      <p className="m-0 line-clamp-2 font-serif text-[11px] italic text-content-secondary">{shot.narration || shot.caption || shot.title}</p>
    </li>
  )
}

function RendersSection({ project }: { project: CreativeProject }) {
  const renders = project.renders.filter(r => r.videoUrl)
  if (!renders.length) { return null }
  return (
    <section className="min-w-0">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="m-0 text-xs font-semibold tracking-widest text-content-secondary">成片</h3>
        <span className="text-[10px] text-content-subtle">{renders.length} VERSION</span>
      </div>
      <Sprockets />
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {renders.map((render, i) => (
          <li key={render.videoUrl ?? i}>
            <video src={render.videoUrl ?? undefined} controls className="w-full rounded-panel border border-outline bg-black" />
            <p className="mt-1 font-mono text-[10px] text-content-subtle">
              final-{i + 1}.mp4 · {render.status === 'completed' ? '已完成' : render.status}
            </p>
          </li>
        ))}
      </ol>
    </section>
  )
}
