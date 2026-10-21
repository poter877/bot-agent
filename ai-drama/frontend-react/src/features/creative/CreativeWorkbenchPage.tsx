import { CreativeToolboxPanel } from './CreativeToolboxPanel'
import { pipelineApi, pipelineQueries } from '@/entities/creative/pipeline'
import { AgentStageWatcher } from './AgentStageWatcher'
import { CreativeBoard } from './CreativeBoard'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ChevronDown, Film, MessageSquare, Settings2, Wrench } from 'lucide-react'
import { creativeQueries } from '@/entities/creative/queries'
import { Button, IconButton } from '@/shared/ui/button'
import { CreativeChatPanel } from './CreativeChatPanel'
import { type CreativeStage } from './creative-store'
import { useCreativeCopy } from './creative-locales'

/**
 * 视频制片工作台——OpenMontage 对话式制片布局：
 * 流程条（状态/建立/继续/重试）→ 制片看板 → Tab（工具目录）→ 制作对话。
 * 审阅确认在制作对话（PipelineReviewCards）；画面/声音/成片在看板呈现。
 */
export function CreativeWorkbenchPage({ projectId }: { projectId: number }) {
  const copy = useCreativeCopy()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const options = creativeQueries.detail(projectId)
  const query = useQuery(options)
  const pipeline = useQuery(pipelineQueries.detail(projectId))
  const pipelineRevision = pipeline.data?.run?.revision
  const projectRevision = query.data?.revision
  useEffect(() => {
    if (pipelineRevision && projectRevision && pipelineRevision > projectRevision) {
      void queryClient.invalidateQueries({ queryKey: creativeQueries.detail(projectId).queryKey })
    }
  }, [pipelineRevision, projectRevision, projectId, queryClient])
  const [stage, setStage] = useState<CreativeStage>('board')

  const disabled = query.isPending || pipeline.isPending || pipeline.data?.run?.stale === true

  const stages: { id: CreativeStage; label: string; icon: typeof Film }[] = [
    { id: 'board', label: '制片看板', icon: Film },
    { id: 'toolbox', label: '工具目录', icon: Wrench },
  ]

  const startOrAction = (action: 'start' | 'continue' | 'retry' | 'sync') => {
    if (action === 'start' || !pipeline.data?.run) {
      void pipelineApi.start(projectId, query.data?.revision ?? 1)
        .then(result => { queryClient.setQueryData(pipelineQueries.detail(projectId).queryKey, result as never) })
        .catch(() => { void queryClient.invalidateQueries({ queryKey: pipelineQueries.detail(projectId).queryKey }) })
      return
    }
    const run = pipeline.data.run
    void pipelineApi.action(projectId, run.id, { action, version: run.version })
      .then(result => { queryClient.setQueryData(pipelineQueries.detail(projectId).queryKey, result as never) })
      .catch(() => { void queryClient.invalidateQueries({ queryKey: pipelineQueries.detail(projectId).queryKey }) })
  }

  return <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4 md:p-6">
    <header className="mb-4 flex flex-wrap items-center gap-3">
      <IconButton aria-label={copy.back} title={copy.back} onClick={() => navigate('/')}><ArrowLeft size={17} aria-hidden /></IconButton>
      <div className="min-w-0 flex-1"><p className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-content-muted"><span className="rounded-pill bg-brand-soft px-2 py-0.5 text-brand-content">{query.data?.category ?? ''}</span></p><h1 className="truncate font-display text-xl font-bold tracking-tight">{query.data?.title ?? ''}</h1></div>
      <Button size="sm" variant="ghost" onClick={() => navigate('/settings')}><Settings2 size={14} aria-hidden />{copy.settings}</Button>
    </header>

    <AgentStageWatcher projectId={projectId} runId={pipeline.data?.run?.id ?? null} version={pipeline.data?.run?.version ?? null} />
    {(query.isError || pipeline.isError) && <div role="alert" className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-control border border-danger/30 bg-danger-soft p-3 text-xs leading-relaxed text-danger"><p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{pipeline.isError ? pipeline.error?.message : query.error?.message}</p><Button size="sm" onClick={() => { void query.refetch(); void pipeline.refetch() }}>重试</Button></div>}

    <section aria-label="视频制片" className="min-w-0">
      <div role="tablist" aria-label="视频制片" className="mb-4 flex gap-1 overflow-x-auto border-b border-outline pb-2">
        {stages.map(({ id, label, icon: Icon }, index) => <button type="button" key={id} id={`creative-tab-${id}`} role="tab" tabIndex={stage === id ? 0 : -1} aria-selected={stage === id} aria-controls={`creative-panel-${id}`} className="flex shrink-0 items-center gap-2 rounded-control border-0 px-3 py-2 text-xs font-semibold focus-visible:outline-none focus-visible:shadow-full" style={stage === id ? { background: 'var(--color-brand-soft)', color: 'var(--color-brand-content)' } : undefined} onClick={() => setStage(id)} onKeyDown={(event) => {
          const next = event.key === 'ArrowRight' ? (index + 1) % stages.length : event.key === 'ArrowLeft' ? (index + stages.length - 1) % stages.length : null
          if (next == null) return
          event.preventDefault(); setStage(stages[next].id); document.getElementById(`creative-tab-${stages[next].id}`)?.focus()
        }}><Icon size={14} aria-hidden />{label}</button>)}
      </div>
      <div role="tabpanel" id={`creative-panel-${stage}`} aria-labelledby={`creative-tab-${stage}`}>
        {stage === 'board' && query.data && (
          <CreativeBoard
            project={query.data}
            state={pipeline.data}
            loading={pipeline.isPending}
            disabled={disabled}
            onStart={() => startOrAction('start')}
            onAction={(action) => startOrAction(action)}
          />
        )}
        {stage === 'toolbox' && <CreativeToolboxPanel project={query.data!} disabled={disabled} canRun={!disabled} onProjectUpdated={p => queryClient.setQueryData(options.queryKey, p)} onBusyChange={() => undefined} />}
      </div>
    </section>

    {query.data && (
      <details open className="min-w-0 overflow-hidden rounded-panel border border-outline bg-surface">
        <summary className="flex cursor-pointer list-none items-center gap-2 border-b border-outline px-4 py-3 text-sm font-semibold focus-visible:outline-none focus-visible:shadow-focus"><MessageSquare size={15} className="text-brand" aria-hidden />{copy.chatTitle}<ChevronDown size={14} className="ml-auto text-content-muted" aria-hidden /></summary>
        <CreativeChatPanel project={query.data} />
      </details>
    )}
  </div>
}
