import { CreativeToolboxPanel } from './CreativeToolboxPanel'
import { pipelineApi, pipelineQueries } from '@/entities/creative/pipeline'
import { AgentStageWatcher } from './AgentStageWatcher'
import { CreativeBoard } from './CreativeBoard'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Settings2, Wrench } from 'lucide-react'
import { creativeQueries } from '@/entities/creative/queries'
import { Button, IconButton } from '@/shared/ui/button'
import { CreativeChatPanel } from './CreativeChatPanel'
import { Modal } from '@/shared/ui/Modal'
import { useCreativeCopy } from './creative-locales'

/**
 * 视频制片工作台——OpenMontage 对话式制片布局：
 * 看板全宽承载流程（状态/建立/继续/重试 + 剧本/分镜/成片），制作对话在下方审阅。
 * 工具目录是项目级辅助面，从 header 弹层进入，不占版面。
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
  const [toolboxOpen, setToolboxOpen] = useState(false)

  const disabled = query.isPending || pipeline.isPending || pipeline.data?.run?.stale === true

  const runAction = (action: 'continue' | 'retry' | 'sync') => {
    const run = pipeline.data?.run
    if (!run) return
    void pipelineApi.action(projectId, run.id, { action, version: run.version })
      .then(result => { queryClient.setQueryData(pipelineQueries.detail(projectId).queryKey, result as never) })
      .catch(() => { void queryClient.invalidateQueries({ queryKey: pipelineQueries.detail(projectId).queryKey }) })
  }

  return <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4 md:p-6">
    <header className="mb-4 flex flex-wrap items-center gap-3">
      <IconButton aria-label={copy.back} title={copy.back} onClick={() => navigate('/')}><ArrowLeft size={17} aria-hidden /></IconButton>
      <div className="min-w-0 flex-1"><p className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-content-muted"><span className="rounded-pill bg-brand-soft px-2 py-0.5 text-brand-content">{query.data?.category ?? ''}</span></p><h1 className="truncate font-display text-xl font-bold tracking-tight">{query.data?.title ?? ''}</h1></div>
      <Button size="sm" variant="ghost" onClick={() => setToolboxOpen(true)}><Wrench size={14} aria-hidden />工具目录</Button>
      <Button size="sm" variant="ghost" onClick={() => navigate('/settings')}><Settings2 size={14} aria-hidden />{copy.settings}</Button>
    </header>

    <AgentStageWatcher projectId={projectId} runId={pipeline.data?.run?.id ?? null} version={pipeline.data?.run?.version ?? null} />
    {(query.isError || pipeline.isError) && <div role="alert" className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-control border border-danger/30 bg-danger-soft p-3 text-xs leading-relaxed text-danger"><p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{pipeline.isError ? pipeline.error?.message : query.error?.message}</p><Button size="sm" onClick={() => { void query.refetch(); void pipeline.refetch() }}>重试</Button></div>}

    {query.data && (
      <CreativeBoard
        project={query.data}
        state={pipeline.data}
        loading={pipeline.isPending}
        disabled={disabled}
        onAction={runAction}
      />
    )}

    {query.data && <CreativeChatPanel project={query.data} />}

    <Modal open={toolboxOpen} onOpenChange={setToolboxOpen} title="工具目录" width={1100}>
      {query.data && <CreativeToolboxPanel project={query.data} disabled={disabled} canRun={!disabled} onProjectUpdated={p => queryClient.setQueryData(options.queryKey, p)} onBusyChange={() => undefined} />}
    </Modal>
  </div>
}
