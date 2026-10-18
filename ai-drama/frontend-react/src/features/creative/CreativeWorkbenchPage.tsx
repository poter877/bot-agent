import { CreativeToolsPanel } from './CreativeToolsPanel'
import { CreativeToolboxPanel } from './CreativeToolboxPanel'
import { pipelineQueries } from '@/entities/creative/pipeline'
import { useProductionText } from '@/entities/creative/catalog'
import { CreativePipelinePanel } from './CreativePipelinePanel'
import { useCreativeCatalog, useCatalogText } from '@/entities/creative/catalog'
import { CreativeProductionPanel } from './CreativeProductionPanel'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useBeforeUnload, useBlocker, useNavigate } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useStore } from 'zustand'
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, Circle, Clapperboard, FileText, Film, Loader2, MessageSquare, Music2, Play as PlayIcon, Save, Settings2, Sparkles } from 'lucide-react'
import { creativeApi } from '@/entities/creative/api'
import { creativeQueries } from '@/entities/creative/queries'
import { hasActiveShotTasks, newCreativeShot, taskIsActive, toCreativeDraft, type CreativeDraft, type CreativeProject, type CreativeShot } from '@/entities/creative/model'
import { ApiError } from '@/shared/api/client'
import { uploadApi } from '@/shared/api/upload'
import { qk } from '@/shared/api/query-keys'
import { cn } from '@/shared/lib/cn'
import { Button, IconButton } from '@/shared/ui/button'
import { Modal } from '@/shared/ui/Modal'
import { ImageViewer, VideoViewer } from '@/shared/ui/media-viewers'
import { CreativeBriefPanel } from './CreativeBriefPanel'
import { CreativeShotsPanel } from './CreativeShotsPanel'
import { CreativeAudioPanel } from './CreativeAudioPanel'
import { CreativeExportPanel } from './CreativeExportPanel'
import { CreativeChatPanel } from './CreativeChatPanel'
import { createCreativeStore, type CreativeStage } from './creative-store'
import { mergeCreativeMedia, moveCreativeShot, shotHasMedia, validateCreativeDraft } from './creative-draft'
import { useCreativeCopy } from './creative-locales'
import { hintClass } from './CreativeFields'

type Operation = { kind: 'save'; draft: CreativeDraft } | { kind: 'plan' | 'approve' | 'render' | 'translate'; revision: number; individual?: boolean } | { kind: 'generate'; revision: number; shotId: string; mediaType: 'image' | 'video' }

export function CreativeWorkbenchPage({ projectId }: { projectId: number }) {
  const copy = useCreativeCopy()
  const text = useProductionText()
  const catalog = useCreativeCatalog()
  const localize = useCatalogText()
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
  const [store] = useState(createCreativeStore)
  const stage = useStore(store, (state) => state.stage)
  const selectedId = useStore(store, (state) => state.selectedShotId)
  const [draft, setDraft] = useState<CreativeDraft | null>(null)
  const baseline = useRef<CreativeDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [uploading, setUploading] = useState<string | null>(null)
  const [sourceBusy, setSourceBusy] = useState(false)
  const [chatBusy, setChatBusy] = useState(false)
  const [pipelineDirty, setPipelineDirty] = useState(false)
  const [confirmation, setConfirmation] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null)
  const [preview, setPreview] = useState<{ kind: 'image' | 'video'; src: string; title: string } | null>(null)
  const dirty = draft !== null
  const blocker = useBlocker(dirty || pipelineDirty)
  useBeforeUnload(useCallback((event: BeforeUnloadEvent) => {
    if (dirty || pipelineDirty) { event.preventDefault(); event.returnValue = '' }
  }, [dirty, pipelineDirty]))

  const acceptProject = (project: CreativeProject) => {
    setDraft(null)
    baseline.current = null
    setConflict(false)
    setError(null)
    queryClient.setQueryData(options.queryKey, project)
    void queryClient.invalidateQueries({ queryKey: pipelineQueries.detail(projectId).queryKey })
    void queryClient.invalidateQueries({ queryKey: qk.dramas() })
  }

  const operation = useMutation({
    mutationFn: async (action: Operation) => {
      await queryClient.cancelQueries({ queryKey: options.queryKey })
      switch (action.kind) {
        case 'save': return creativeApi.save(projectId, action.draft)
        case 'plan': return creativeApi.plan(projectId, action.revision)
        case 'approve': return creativeApi.approve(projectId, action.revision)
        case 'generate': return creativeApi.generate(projectId, action.shotId, action.mediaType, action.revision)
        case 'render': return action.individual ? creativeApi.render(projectId, action.revision, { individual: true }) : creativeApi.render(projectId, action.revision)
        case 'translate': return creativeApi.translate(projectId, action.revision)
      }
    },
    onMutate: () => { setError(null); setConflict(false) },
    onSuccess: async (project, action) => {
      await queryClient.cancelQueries({ queryKey: options.queryKey })
      acceptProject(project)
      if (action.kind === 'plan') store.getState().setStage('shots')
      if (action.kind === 'render') store.getState().setStage('export')
    },
    onError: (cause) => {
      if (cause instanceof ApiError && (cause.status === 409 || cause.code === 409)) setConflict(true)
      else setError(cause instanceof Error ? cause.message : String(cause))
      void queryClient.invalidateQueries({ queryKey: options.queryKey })
    },
  })

  if (!Number.isInteger(projectId) || projectId <= 0 || (query.isError && !query.data)) {
    return <div className="flex h-full flex-col items-center justify-center gap-4 p-8"><h1 className="text-lg font-bold">{copy.invalidProject}</h1>{query.error && <p className="max-w-lg break-words text-sm text-danger">{query.error.message}</p>}<div className="flex gap-3"><Button onClick={() => navigate('/')}>{copy.back}</Button>{projectId > 0 && <Button onClick={() => void query.refetch()}>{copy.retry}</Button>}</div></div>
  }
  if (!query.data) return <div className="flex h-full items-center justify-center gap-3 p-8" role="status"><Loader2 size={20} className="animate-spin text-brand" aria-hidden /><span className="text-sm text-content-muted">{copy.loading}</span></div>

  const project = query.data
  const recipe = catalog.data?.find(item => item.id === project.category) ?? project.recipe
  const current = draft ?? toCreativeDraft(project)
  const shotTasksActive = hasActiveShotTasks(project)
  const renderActive = project.renders.some((render) => taskIsActive(render.status))
  const pipelineBusy = ['running', 'waiting', 'pausing'].includes(pipeline.data?.run?.status ?? '')
  const busy = pipelineBusy || operation.isPending || uploading !== null || chatBusy || sourceBusy
  const editDisabled = busy || shotTasksActive
  const approved = !dirty && project.approvedRevision === project.revision
  const canRun = !dirty && !busy && !shotTasksActive && !conflict
  const readyCount = current.shots.filter(shotHasMedia).length
  const planReady = current.shots.length > 0 && current.shots.every((shot) => !!shot.visualPrompt.trim() || shotHasMedia(shot))
  const planInProgress = operation.isPending && operation.variables?.kind === 'plan'
  const mutationShotId = operation.isPending && operation.variables?.kind === 'generate' ? operation.variables.shotId : null

  const changeDraft = (update: (value: CreativeDraft) => CreativeDraft) => {
    if (editDisabled) return
    if (!baseline.current) baseline.current = toCreativeDraft(project)
    setDraft((value) => update(value ?? toCreativeDraft(project)))
    setError(null)
  }
  const updateShot = (id: string, patch: Partial<CreativeShot>) => changeDraft((value) => ({ ...value, shots: value.shots.map((shot) => shot.id === id ? { ...shot, ...patch } : shot) }))
  const setStage = (value: CreativeStage) => {
    if(pipelineDirty && value !== stage) {
      setConfirmation({title:copy.unsaved,message:copy.leaveWarning,onConfirm:()=>{setPipelineDirty(false);store.getState().setStage(value)}})
    } else store.getState().setStage(value)
  }
  const save = () => {
    if (!draft || editDisabled) return
    if (!validateCreativeDraft(draft)) { setError(copy.validation); return }
    operation.mutate({ kind: 'save', draft: mergeCreativeMedia(draft, baseline.current ?? draft, project) })
  }
  const plan = () => {
    if (!canRun || !current.brief.idea.trim()) return
    const run = () => operation.mutate({ kind: 'plan', revision: project.revision })
    if (current.shots.length || current.plan.script.trim()) setConfirmation({ title: copy.regeneratePlan, message: copy.regenerateWarning, onConfirm: run })
    else run()
  }
  const upload = async (key: string, kind: 'image' | 'video' | 'audio', file: File, apply: (value: CreativeDraft, path: string) => CreativeDraft) => {
    if (editDisabled) return
    setUploading(key)
    setError(null)
    try {
      const result = await uploadApi[kind](file)
      if (!baseline.current) baseline.current = toCreativeDraft(project)
      setDraft((value) => apply(value ?? toCreativeDraft(project), result.path || result.url))
    } catch (cause) { setError(cause instanceof Error ? cause.message : copy.uploadFailed) }
    finally { setUploading(null) }
  }
  const reload = () => setConfirmation({ title: copy.reload, message: copy.reloadWarning, onConfirm: () => {
    setDraft(null); baseline.current = null; setConflict(false); setError(null); void query.refetch()
  } })

  const stages: { id: CreativeStage; label: string; icon: typeof FileText }[] = [
    { id: 'pipeline', label: text('制作流程', 'Workflow'), icon: PlayIcon },
    { id: 'toolbox', label: text('制作工具箱','Toolbox'), icon: Settings2 },
    { id: 'tools', label: text('制作工具','Production tools'), icon: Settings2 },
    { id: 'brief', label: copy.brief, icon: FileText }, { id: 'shots', label: copy.shots, icon: Clapperboard },
    { id: 'audio', label: copy.audio, icon: Music2 }, { id: 'export', label: copy.export, icon: Film },
  ]
  const workflow = [
    { label: copy.brief, stage: 'brief' as const, done: !!current.brief.idea.trim(), active: false, failed: false, waiting: copy.toComplete },
    { label: copy.plan, stage: 'brief' as const, done: planReady, active: planInProgress, failed: operation.isError && operation.variables?.kind === 'plan', waiting: copy.toComplete },
    { label: copy.approve, stage: 'shots' as const, done: approved, active: false, failed: false, waiting: copy.toApprove },
    { label: copy.shots, stage: 'shots' as const, done: planReady && readyCount === current.shots.length, active: shotTasksActive, failed: (operation.isError && operation.variables?.kind === 'generate') || project.shots.some((shot) => (shot.mediaType === 'video' ? shot.videoTask : shot.imageTask)?.status === 'failed'), waiting: copy.toProduce },
    { label: copy.audio, stage: 'audio' as const, done: !!(current.audio.narrationUrl || current.audio.musicUrl || current.shots.some((shot) => shot.caption.trim() || shot.audioUrl)), active: false, failed: false, waiting: copy.optional, doneLabel: copy.added },
    { label: copy.export, stage: 'export' as const, done: project.renders.some((render) => render.revision === project.revision && render.status === 'completed'), active: renderActive, failed: (operation.isError && operation.variables?.kind === 'render') || project.renders[0]?.status === 'failed', waiting: copy.toProduce },
  ]

  return <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4 md:p-6">
    <header className="mb-4 flex flex-wrap items-center gap-3">
      <IconButton aria-label={copy.back} title={copy.back} onClick={() => navigate('/')}><ArrowLeft size={17} aria-hidden /></IconButton>
      <div className="min-w-0 flex-1"><p className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-content-muted"><Sparkles size={12} className="text-brand" aria-hidden />{copy.title}<span className="rounded-pill bg-brand-soft px-2 py-0.5 text-brand-content">{localize(recipe?.title) || project.category}</span><span>{project.aspectRatio}</span></p><h1 className="truncate font-display text-xl font-bold tracking-tight">{current.title}</h1></div>
      <Button size="sm" variant="ghost" onClick={() => navigate('/settings')}><Settings2 size={14} aria-hidden />{copy.settings}</Button>
      <div className="flex items-center gap-2"><span role="status" className={cn('hidden text-xs sm:inline', dirty ? 'text-brand-content' : 'text-content-muted')}>{dirty ? copy.unsaved : copy.saved}</span><Button size="sm" variant={dirty ? 'primary' : 'default'} loading={operation.isPending && operation.variables?.kind === 'save'} disabled={!dirty || editDisabled || conflict} onClick={save}><Save size={14} aria-hidden />{copy.save}</Button></div>
    </header>

    {(error || conflict || (query.isError && query.data)) && <div role="alert" className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-control border border-danger/30 bg-danger-soft p-3 text-xs leading-relaxed text-danger"><p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{conflict ? copy.conflict : error || query.error?.message}</p>{conflict && <Button size="sm" onClick={reload}>{copy.reload}</Button>}{query.isError && !error && !conflict && <Button size="sm" onClick={() => void query.refetch()}>{copy.retry}</Button>}</div>}
    <div className="grid min-w-0 flex-1 items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)] 2xl:grid-cols-[340px_minmax(0,1fr)]">
      <details open className="min-w-0 overflow-hidden rounded-panel border border-outline bg-surface lg:sticky lg:top-0">
        <summary className="flex cursor-pointer list-none items-center gap-2 border-b border-outline px-4 py-3 text-sm font-semibold focus-visible:outline-none focus-visible:shadow-focus"><MessageSquare size={15} className="text-brand" aria-hidden />{copy.chatTitle}<ChevronDown size={14} className="ml-auto text-content-muted" aria-hidden /></summary>
        {dirty && <p className="border-b border-outline bg-brand-soft px-4 py-2 text-xs text-brand-content">{copy.saveFirst}</p>}
        <CreativeChatPanel project={project} disabled={dirty || pipelineDirty || busy || shotTasksActive || conflict} onProjectUpdated={acceptProject} onGoToStage={setStage} onBusyChange={setChatBusy} />
      </details>
      <section aria-label={copy.title} className="min-w-0">
        {stage !== 'pipeline' && stage !== 'tools' && stage !== 'toolbox' && <nav aria-label={copy.plan} className="mb-4 flex gap-2 overflow-x-auto rounded-panel border border-outline bg-surface p-3">
          {workflow.map((node, index) => <div key={node.label} className="flex min-w-[124px] flex-1 items-center gap-2">
            <button type="button" onClick={() => setStage(node.stage)} className="flex min-w-[86px] flex-1 flex-col items-start gap-2 rounded-control border-0 bg-transparent p-2 text-left hover:bg-hover-overlay focus-visible:outline-none focus-visible:shadow-focus">
              <span className={cn('flex items-center gap-1.5 text-[10px]', node.active ? 'text-brand-content' : node.failed ? 'text-danger' : node.done ? 'text-success' : 'text-content-subtle')}>{node.active ? <Loader2 size={13} className="animate-spin" aria-hidden /> : node.done && !node.failed ? <CheckCircle2 size={13} aria-hidden /> : <Circle size={13} aria-hidden />}{node.active ? copy.processing : node.failed ? copy.failed : node.done ? node.doneLabel ?? copy.completed : node.waiting}</span>
              <span className="text-xs font-semibold text-content-secondary">{node.label}</span>
            </button>{index < workflow.length - 1 && <ArrowRight size={13} className="shrink-0 text-content-subtle" aria-hidden />}
          </div>)}
        </nav>}
        {stage !== 'pipeline' && stage !== 'tools' && stage !== 'toolbox' && <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-control bg-brand-soft px-4 py-3">
          <div className="min-w-0 flex-1"><p className="flex items-center gap-2 text-xs font-semibold text-brand-content">{approved ? <Check size={14} aria-hidden /> : <Sparkles size={14} aria-hidden />}{shotTasksActive ? copy.activeTasksHint : dirty ? copy.saveFirst : approved ? copy.approved : copy.approveFirst}</p><p className={cn(hintClass, 'mt-1')}>{copy.approvalHint}</p></div>
          {!approved && <Button size="sm" disabled={!canRun || !planReady} loading={operation.isPending && operation.variables?.kind === 'approve'} onClick={() => operation.mutate({ kind: 'approve', revision: project.revision })}>{copy.approve}</Button>}
        </div>}
        <div role="tablist" aria-label={copy.title} className="mb-4 flex gap-1 overflow-x-auto border-b border-outline pb-2">
          {stages.map(({ id, label, icon: Icon }, index) => <button type="button" key={id} id={`creative-tab-${id}`} role="tab" tabIndex={stage === id ? 0 : -1} aria-selected={stage === id} aria-controls={`creative-panel-${id}`} className={cn('flex shrink-0 items-center gap-2 rounded-control border-0 px-3 py-2 text-xs font-semibold focus-visible:outline-none focus-visible:shadow-focus', stage === id ? 'bg-brand-soft text-brand-content' : 'bg-transparent text-content-muted hover:bg-hover-overlay')} onClick={() => setStage(id)} onKeyDown={(event) => {
            const next = event.key === 'ArrowRight' ? (index + 1) % stages.length : event.key === 'ArrowLeft' ? (index + stages.length - 1) % stages.length : event.key === 'Home' ? 0 : event.key === 'End' ? stages.length - 1 : null
            if (next == null) return
            event.preventDefault(); setStage(stages[next].id); document.getElementById(`creative-tab-${stages[next].id}`)?.focus()
          }}><Icon size={14} aria-hidden />{label}</button>)}
        </div>
        <div role="tabpanel" id={`creative-panel-${stage}`} aria-labelledby={`creative-tab-${stage}`}>
          {stage === 'pipeline' && <CreativePipelinePanel project={project} state={pipeline.data} loading={pipeline.isPending} error={pipeline.error} disabled={dirty || operation.isPending || uploading !== null || sourceBusy || chatBusy} onReload={() => void pipeline.refetch()} onOpenEditor={setStage} onDirtyChange={setPipelineDirty} />}
          {stage === 'tools' && <CreativeToolsPanel project={project} draft={current} disabled={editDisabled} canRun={canRun} onChange={changeDraft} onProjectUpdated={acceptProject} onBusyChange={setSourceBusy} />}
          {stage === 'toolbox' && <CreativeToolboxPanel project={project} disabled={editDisabled} canRun={canRun} onProjectUpdated={acceptProject} onBusyChange={setSourceBusy} />}
          {stage === 'brief' && <div className="space-y-4"><CreativeProductionPanel project={project} draft={current} recipe={recipe} disabled={editDisabled} canRun={canRun} onChange={changeDraft} onProjectUpdated={acceptProject} onBusyChange={setSourceBusy} /><CreativeBriefPanel draft={current} copy={copy} disabled={editDisabled} canPlan={canRun && !!current.brief.idea.trim()} planning={planInProgress} onChange={changeDraft} onPlan={plan} onNext={() => setStage('shots')} /></div>}
          {stage === 'shots' && <CreativeShotsPanel project={project} draft={current} copy={copy} selectedId={selectedId} disabled={editDisabled} canGenerate={canRun && approved} uploading={uploading} generating={mutationShotId} onSelect={store.getState().selectShot} onAdd={() => {
            const shot = { ...newCreativeShot(`${copy.shot} ${current.shots.length + 1}`), mediaType: recipe?.mediaType || 'image' as const }
            changeDraft((value) => ({ ...value, shots: [...value.shots, shot] }))
            store.getState().selectShot(shot.id)
          }} onUpdate={updateShot} onMove={(id, delta) => changeDraft((value) => ({ ...value, shots: moveCreativeShot(value.shots, id, delta) }))} onDelete={(id) => setConfirmation({ title: copy.remove, message: copy.deleteWarning, onConfirm: () => changeDraft((value) => ({ ...value, shots: value.shots.filter((shot) => shot.id !== id) })) })} onUpload={(id, kind, file) => void upload(id, kind, file, (value, path) => ({ ...value, shots: value.shots.map((shot) => shot.id === id ? kind === 'audio' ? { ...shot, audioUrl: path, audioTrimStart: 0 } : { ...shot, [kind === 'image' ? 'imageUrl' : 'videoUrl']: path, [kind === 'image' ? 'imageTaskId' : 'videoTaskId']: null } : shot) }))} onGenerate={(shotId, mediaType) => operation.mutate({ kind: 'generate', shotId, mediaType, revision: project.revision })} onPreview={(src, title) => setPreview({ kind: 'image', src, title })} />}
          {stage === 'audio' && <CreativeAudioPanel draft={current} copy={copy} disabled={editDisabled} uploading={uploading} onChange={(patch) => changeDraft((value) => ({ ...value, audio: { ...value.audio, ...patch } }))} onUpload={(kind, file) => void upload(kind, 'audio', file, (value, path) => ({ ...value, audio: { ...value.audio, [kind === 'music' ? 'musicUrl' : 'narrationUrl']: path } }))} onNext={() => setStage('export')} canTranslate={canRun && current.shots.some(shot => !!shot.caption.trim() || !!shot.narration.trim())} translating={operation.isPending && operation.variables?.kind === 'translate'} onTranslate={() => operation.mutate({ kind: 'translate', revision: project.revision })} onTargetLanguage={(language) => changeDraft(value => ({ ...value, brief: { ...value.brief, language } }))} onMuteSource={() => changeDraft(value => ({ ...value, shots: value.shots.map(shot => ({ ...shot, originalVolume: 0 })) }))} />}
          {stage === 'export' && <CreativeExportPanel project={project} draft={current} copy={copy} canRender={canRun && approved && !renderActive} rendering={renderActive || (operation.isPending && operation.variables?.kind === 'render')} onRender={(individual) => operation.mutate({ kind: 'render', revision: project.revision, individual })} onPreview={(src, title) => setPreview({ kind: 'video', src, title })} />}
        </div>
      </section>
    </div>
    <Modal open={!!confirmation} onOpenChange={(open) => { if (!open) setConfirmation(null) }} title={confirmation?.title || copy.confirm} width={440} footer={<><Button onClick={() => setConfirmation(null)}>{copy.cancel}</Button><Button variant="primary" onClick={() => { const action = confirmation?.onConfirm; setConfirmation(null); action?.() }}>{copy.confirm}</Button></>}><p className="text-sm leading-relaxed text-content-muted">{confirmation?.message}</p></Modal>
    <Modal open={blocker.state === 'blocked'} onOpenChange={(open) => { if (!open && blocker.state === 'blocked') blocker.reset() }} title={copy.unsaved} width={440} footer={<><Button onClick={() => { if (blocker.state === 'blocked') blocker.reset() }}>{copy.cancel}</Button><Button variant="danger" onClick={() => { if (blocker.state === 'blocked') blocker.proceed() }}>{copy.discard}</Button></>}><p className="text-sm leading-relaxed text-content-muted">{copy.leaveWarning}</p></Modal>
    <ImageViewer open={preview?.kind === 'image'} src={preview?.src || ''} title={preview?.title || ''} onClose={() => setPreview(null)} />
    <VideoViewer open={preview?.kind === 'video'} src={preview?.src || ''} downloadHref={preview?.src || ''} title={preview?.title || ''} onClose={() => setPreview(null)} />
  </div>
}
