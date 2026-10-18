import { CreativeProductionFiles } from './CreativeProductionFiles'
import { CreativePipelineToolSteps } from './CreativePipelineToolSteps'
import { toolboxQueries, type ToolboxFile } from '@/entities/creative/toolbox'
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Loader2, Pause, Play, RotateCcw } from 'lucide-react'
import {
  pipelineApi,
  pipelineQueries,
  type PipelineAction,
  type PipelineState,
  type PipelineToolRuntime,
  type PipelineToolExecution,
} from '@/entities/creative/pipeline'
import { useProductionText } from '@/entities/creative/catalog'
import type { CreativeProject } from '@/entities/creative/model'
import { creativeQueries } from '@/entities/creative/queries'
import { Button } from '@/shared/ui/button'
import { Textarea } from '@/shared/ui/input'
import { Modal } from '@/shared/ui/Modal'
import { cn } from '@/shared/lib/cn'
import { CreativeSection, hintClass } from './CreativeFields'

const statuses: Record<string, [string, string]> = {
  ready: ['准备就绪', 'Ready'],
  pending: ['未开始', 'Not started'],
  running: ['执行中', 'Running'],
  pausing: ['正在暂停', 'Pausing'],
  paused: ['已暂停', 'Paused'],
  waiting: ['等待任务完成', 'Waiting for tasks'],
  review: ['待审阅', 'Needs review'],
  completed: ['已完成', 'Completed'],
  failed: ['需处理', 'Needs attention'],
  cancelled: ['已结束', 'Ended'],
}
export function CreativePipelinePanel({
  project,
  state,
  loading,
  error,
  disabled,
  onReload,
  onOpenEditor,
  onDirtyChange,
}: {
  project: CreativeProject
  state?: PipelineState
  loading: boolean
  error?: Error | null
  disabled: boolean
  onReload: () => void
  onOpenEditor: (stage: 'tools' | 'brief' | 'shots' | 'audio' | 'export') => void
  onDirtyChange?: (dirty: boolean) => void
}) {
  const text = useProductionText(),
    client = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [edited, setEdited] = useState<string | null>(null)
  const [historyId, setHistoryId] = useState<number | null>(null)
  const history = useQuery({
    queryKey: ['creative-pipeline-run', project.id, historyId],
    queryFn: () => pipelineApi.run(project.id, historyId!),
    enabled: historyId !== null,
  })
  const [confirmation, setConfirmation] = useState<{
    action: PipelineAction
    stageId?: string
    message: string
  } | null>(null)
  const toolPlan = useQuery(pipelineQueries.toolPlan(project.id, project.revision))
  const toolbox = useQuery(toolboxQueries.catalog())
  const capabilities = useQuery({
    queryKey: ['creative-capabilities', project.id, project.revision],
    queryFn: () => pipelineApi.capabilities(project.id),
    staleTime: 30000,
  })
  const mutation = useMutation({
    mutationFn: async (input: {
      action: PipelineAction | 'start'
      stageId?: string
      edited?: { summary: string; content: string; checks: string[] }
    }) => {
      if (input.action === 'start') return pipelineApi.start(project.id, project.revision)
      if (!state?.run) throw new Error(text('流程不存在', 'No workflow'))
      return pipelineApi.action(project.id, state.run.id, {
        ...input,
        action: input.action,
        version: state.run.version,
      })
    },
    onSuccess: async (result) => {
      await client.cancelQueries({ queryKey: pipelineQueries.detail(project.id).queryKey })
      client.setQueryData(pipelineQueries.detail(project.id).queryKey, result)
      setEdited(null)
      setSelected(null)
      await client.invalidateQueries({ queryKey: creativeQueries.detail(project.id).queryKey })
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: pipelineQueries.detail(project.id).queryKey })
    },
  })
  const toolRecovery = useMutation({
    mutationFn: async (input: { jobId: number; remoteId?: string; retrySubmission?: boolean }) => {
      if (!state?.run) throw new Error(text('流程不存在', 'No workflow'))
      const { jobId, ...options } = input
      await client.cancelQueries({ queryKey: pipelineQueries.detail(project.id).queryKey })
      return pipelineApi.resumeTool(project.id, state.run.id, jobId, {
        version: state.run.version,
        ...options,
      })
    },
    onSuccess: async (result) => {
      await client.cancelQueries({ queryKey: pipelineQueries.detail(project.id).queryKey })
      client.setQueryData(pipelineQueries.detail(project.id).queryKey, result)
      await client.invalidateQueries({ queryKey: creativeQueries.detail(project.id).queryKey })
      await client.invalidateQueries({ queryKey: toolboxQueries.project(project.id).queryKey })
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: pipelineQueries.detail(project.id).queryKey })
    },
  })
  const send = (action: PipelineAction | 'start', stageId?: string) => mutation.mutate({ action, stageId })
  const run = state?.run
      ? { ...state.run, stale: state.run.stale || state.run.revision !== project.revision }
      : null,
    definition = run?.definition ?? state?.definition
  const index = definition?.stages.findIndex((s) => s.id === selected) ?? -1
  const visibleIndex = index >= 0 ? index : Math.min(run?.cursor ?? 0, (definition?.stages.length ?? 1) - 1)
  const stage = definition?.stages[visibleIndex],
    entry = run?.stages[visibleIndex]
  const current = !!run && visibleIndex === run.cursor
  const running = !!run && ['running', 'waiting', 'pausing'].includes(run.status)
  const ended = !!run && ['completed', 'cancelled'].includes(run.status)
  const locked = disabled || mutation.isPending || toolRecovery.isPending
  const label = (status: string) => {
    const pair = statuses[status] ?? [status, status]
    return text(...pair)
  }
  const artifact = entry?.artifact
  const runtime = artifact?.data?.toolRuntime as PipelineToolRuntime | undefined
  const plannedSteps = (toolPlan.data?.steps ?? []).filter((item) => item.stage === stage?.id)
  const actualSteps = runtime?.version === 1 ? runtime.steps : []
  const previewSteps = run?.stale ? [] : plannedSteps
  const toolSteps: PipelineToolExecution[] = [
    ...previewSteps.map(
      (item) =>
        actualSteps.find((actual) => actual.key === item.key) ?? { ...item, status: 'pending' as const },
    ),
    ...actualSteps.filter((item) => !previewSteps.some((planned) => planned.key === item.key)),
  ].sort((a, b) => (a.phase === b.phase ? 0 : a.phase === 'before' ? -1 : 1))
  const allToolSteps =
    run?.stages.flatMap(
      (item) => (item.artifact?.data?.toolRuntime as PipelineToolRuntime | undefined)?.steps ?? [],
    ) ?? []
  const stageToolSteps = toolSteps.filter((item) => item.stage === stage?.id)

  const editable =
    !!stage &&
    !artifact?.data?.translatedShots &&
    !['scene_plan', 'assets', 'edit', 'compose', 'publish'].includes(stage.id)
  const dirty = edited !== null && edited !== artifact?.content
  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])
  if (loading)
    return (
      <p role="status" className={hintClass}>
        {text('正在读取制作流程…', 'Loading workflow…')}
      </p>
    )
  if (error)
    return (
      <div role="alert">
        <p>{text('无法读取制作流程', 'Could not load workflow')}</p>
        <Button onClick={onReload}>{text('重试', 'Retry')}</Button>
      </div>
    )
  if (!definition)
    return (
      <p className={hintClass}>
        {text(
          '此旧项目使用原有编辑器，未新增独立制作流程。',
          'This legacy project uses the existing editor.',
        )}
      </p>
    )
  return (
    <div className="space-y-4">
      <CreativeSection
        title={`${definition.title} · ${text('制作流程', 'Workflow')}`}
        hint={text(
          '各阶段保存输入与产物。审阅后继续；修改项目后需同步，并重新检查后续阶段。',
          'Stages retain their outputs. Review before continuing; sync project edits to invalidate dependent stages.',
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-auto text-xs text-content-muted">
            {definition.stages.length} {text('个阶段', 'stages')}
            {run ? ` · #${run.id} · ${label(run.status)}` : ''}
          </span>
          {(!run || ended) && (
            <Button variant="primary" disabled={locked} onClick={() => send('start')}>
              <Play size={14} />
              {text(run ? '建立新一轮流程' : '建立制作流程', run ? 'New run' : 'Create workflow')}
            </Button>
          )}
          {run && !ended && !running && run.stages[run.cursor]?.status !== 'review' && !run.stale && (
            <Button
              variant="primary"
              disabled={locked}
              onClick={() =>
                send(
                  run.status === 'failed' || run.stages[run.cursor]?.status === 'failed'
                    ? 'retry'
                    : 'continue',
                )
              }
            >
              <Play size={14} />
              {text(
                run.status === 'failed' ? '重试当前阶段' : '继续执行',
                run.status === 'failed' ? 'Retry stage' : 'Continue',
              )}
            </Button>
          )}
          {run && ['running', 'waiting'].includes(run.status) && (
            <Button disabled={locked} onClick={() => send('pause')}>
              <Pause size={14} />
              {text('暂停流程', 'Pause')}
            </Button>
          )}
          {run && !ended && !running && (
            <Button
              variant="ghost"
              disabled={locked || dirty}
              onClick={() =>
                setConfirmation({
                  action: 'cancel',
                  message: text(
                    '结束本轮流程，保留项目、素材与所有阶段记录。',
                    'End this run while retaining project media and stage records.',
                  ),
                })
              }
            >
              {text('结束本轮', 'End run')}
            </Button>
          )}
        </div>
        {disabled && (
          <p className="mt-3 text-xs text-brand-content">
            {text('请先保存修改或等待编辑操作完成。', 'Save edits or wait for the current editing action.')}
          </p>
        )}
        {run?.stale && !ended && (
          <div className="mt-3 rounded-control bg-brand-soft p-3">
            <p className="mb-2 text-xs">
              {text(
                '项目已有新修改，原阶段结果不能直接用于后续制作。同步会保留历史记录，并退回最早受影响的阶段。',
                'The project has changed. Sync retains history and rewinds to the earliest affected stage.',
              )}
            </p>
            <Button
              size="sm"
              disabled={locked || running}
              onClick={() =>
                setConfirmation({
                  action: 'sync',
                  message: text(
                    '将当前已保存的项目同步到流程，并重新检查受影响阶段。',
                    'Sync the saved project and invalidate affected stages.',
                  ),
                })
              }
            >
              {text('同步修改', 'Sync edits')}
            </Button>
          </div>
        )}
        {(mutation.isError || run?.error) && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {mutation.error?.message || run?.error}
          </p>
        )}
        <ol className="m-0 mt-4 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2 xl:grid-cols-3">
          {definition.stages.map((item, i) => {
            const record = run?.stages[i],
              status = record?.status ?? 'pending'
            return (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={dirty && visibleIndex !== i}
                  aria-pressed={visibleIndex === i}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-control border p-3 text-left disabled:opacity-50',
                    visibleIndex === i ? 'border-brand bg-brand-soft' : 'border-outline bg-elevated',
                  )}
                  onClick={() => {
                    setSelected(item.id)
                    setEdited(null)
                  }}
                >
                  <span className="mt-0.5 text-xs text-content-muted">
                    {status === 'completed' ? (
                      <Check size={14} />
                    ) : status === 'running' || status === 'waiting' ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      String(i + 1).padStart(2, '0')
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold">{item.title}</span>
                    <span className="mt-1 block text-[11px] text-content-muted">
                      {label(status)}
                      {record?.attempt ? ` · ${text('尝试', 'Attempt')} ${record.attempt}` : ''}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      </CreativeSection>
      {stage && (
        <CreativeSection
          title={stage.title}
          hint={
            stage.review
              ? text('该阶段产物需要你审阅确认。', 'Review and approve this stage output.')
              : text('执行后会保存产物并进入下一阶段。', 'Outputs are saved before continuing.')
          }
        >
          <div className="mb-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={dirty}
              onClick={() =>
                onOpenEditor(
                  stage.id === 'compose' || stage.id === 'publish'
                    ? 'export'
                    : stage.id === 'assets' || stage.id === 'scene_plan' || stage.id === 'edit'
                      ? 'shots'
                      : 'brief',
                )
              }
            >
              {text('打开对应编辑器', 'Open editor')}
            </Button>
            {['rig_plan', 'assets', 'research', 'idea'].includes(stage.id) && (
              <Button size="sm" disabled={dirty} onClick={() => onOpenEditor('tools')}>
                {text('打开制作工具', 'Production tools')}
              </Button>
            )}
            {stage.id === 'assets' && (
              <Button size="sm" onClick={() => onOpenEditor('audio')}>
                {text('补充配音与字幕', 'Add audio and captions')}
              </Button>
            )}
            {run && !ended && !running && visibleIndex <= run.cursor && entry?.status !== 'pending' && (
              <Button
                size="sm"
                disabled={locked || run.stale || dirty}
                onClick={() =>
                  setConfirmation({
                    action: 'rewind',
                    stageId: stage.id,
                    message: text(
                      `退回「${stage.title}」重新执行，并使后续阶段结果失效。已生成的素材会保留。`,
                      `Rerun ${stage.title} and invalidate downstream results. Existing media is retained.`,
                    ),
                  })
                }
              >
                <RotateCcw size={12} />
                {text('退回此阶段', 'Rewind here')}
              </Button>
            )}
          </div>
          {toolRecovery.isError && (
            <p role="alert" className="mb-3 text-sm text-danger">
              {toolRecovery.error?.message}
            </p>
          )}
          {!!toolPlan.data?.issues?.some((issue) => issue.stage === stage.id) && (
            <div className="mb-3 space-y-2 rounded-control bg-brand-soft p-3">
              <p className="text-xs font-semibold text-brand-content">
                {text('此阶段还需补充输入', 'More input is needed for this stage')}
              </p>
              {toolPlan.data.issues
                .filter((issue) => issue.stage === stage.id)
                .map((issue, index) => (
                  <p key={index} className="break-words text-xs text-content-muted">
                    {issue.message}
                  </p>
                ))}
            </div>
          )}
          <CreativePipelineToolSteps
            steps={stageToolSteps}
            planned={!runtime}
            project={project}
            tools={toolbox.data?.tools ?? []}
            allSteps={[...(toolPlan.data?.steps ?? []), ...allToolSteps]}
            disabled={locked || running || run?.stale || dirty || !run || ended || !current}
            pending={toolRecovery.isPending}
            onRecover={(input) => toolRecovery.mutate(input)}
          />
          {toolPlan.isError && !runtime && (
            <p className="mb-3 text-xs text-content-muted">
              {text(
                '自动制作步骤暂时无法预览，执行时会记录实际工具与产物。',
                'The automation preview is unavailable. Actual tools and outputs are recorded during execution.',
              )}
              <button type="button" className="ml-2 underline" onClick={() => void toolPlan.refetch()}>
                {text('重新读取', 'Reload')}
              </button>
            </p>
          )}
          {artifact ? (
            <>
              {Array.isArray(artifact.data?.files) && (
                <CreativeProductionFiles files={artifact.data.files as ToolboxFile[]} />
              )}
              <p className="mb-3 text-sm font-semibold">{artifact.summary}</p>
              {editable && !ended && entry?.status === 'review' && current ? (
                <Textarea
                  aria-label={text('编辑阶段产物', 'Edit stage output')}
                  rows={12}
                  maxLength={40000}
                  value={edited ?? artifact.content}
                  disabled={locked || run?.stale}
                  onChange={(e) => setEdited(e.target.value)}
                />
              ) : (
                <div className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-control bg-elevated p-4 text-xs leading-relaxed">
                  {artifact.content}
                </div>
              )}
              {!!artifact.checks.length && (
                <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-content-muted">
                  {artifact.checks.map((check, i) => (
                    <li key={i}>{check}</li>
                  ))}
                </ul>
              )}
              {typeof artifact.data?.manifestUrl === 'string' &&
                artifact.data.manifestUrl.startsWith('/static/creative/') && (
                  <a
                    className="mt-3 inline-block text-sm text-brand-content"
                    href={artifact.data.manifestUrl}
                    download
                  >
                    {text('下载交付清单', 'Download delivery manifest')}
                  </a>
                )}
            </>
          ) : (
            <p className={hintClass}>
              {text(
                '执行后，这里会显示该阶段的真实产物。',
                'The stage output will appear here after execution.',
              )}
            </p>
          )}
          {current && !ended && entry?.status === 'review' && artifact && (
            <Button
              className="mt-4"
              variant="primary"
              disabled={locked || run?.stale || !(edited ?? artifact.content).trim()}
              onClick={() =>
                mutation.mutate({
                  action: 'approve',
                  ...(edited !== null
                    ? { edited: { summary: artifact.summary, content: edited, checks: artifact.checks } }
                    : {}),
                })
              }
            >
              <Check size={14} />
              {text('确认此阶段', 'Approve stage')}
            </Button>
          )}
          {dirty && (
            <div className="mt-3 flex items-center gap-3">
              <p className={hintClass}>
                {text(
                  '文字修改尚未确认，请确认此阶段或放弃修改。',
                  'Approve this stage to save the edited text, or discard changes.',
                )}
              </p>
              <Button size="sm" onClick={() => setEdited(null)}>
                {text('放弃文字修改', 'Discard text edits')}
              </Button>
            </div>
          )}
        </CreativeSection>
      )}
      <details className="rounded-panel border border-outline p-4">
        <summary className="cursor-pointer text-sm font-semibold">
          {text('制作能力与所需素材', 'Capabilities and required inputs')}
        </summary>
        <div className="mt-3 space-y-3">
          {capabilities.isError ? (
            <p className="text-xs text-danger">
              {text('能力检查失败，请刷新重试', 'Could not inspect capabilities')}
            </p>
          ) : (
            capabilities.data?.map((item) => (
              <div key={item.id}>
                <p className="text-xs font-semibold">
                  {item.available ? '✓' : '○'} {item.title}
                </p>
                <p className={hintClass}>{item.detail}</p>
              </div>
            ))
          )}
        </div>
      </details>
      {(state?.history.length ?? 0) > 1 && (
        <details className="rounded-panel border border-outline p-4">
          <summary className="cursor-pointer text-sm font-semibold">
            {text('最近制作轮次', 'Recent workflow runs')}
          </summary>
          <div className="mt-3 flex flex-wrap gap-2">
            {state?.history
              .filter((item) => item.id !== run?.id)
              .map((item) => (
                <Button size="sm" key={item.id} onClick={() => setHistoryId(item.id)}>
                  #{item.id} · {label(item.status)} · {new Date(item.createdAt).toLocaleString()}
                </Button>
              ))}
          </div>
        </details>
      )}
      <Modal
        open={historyId !== null}
        onOpenChange={(open) => {
          if (!open) setHistoryId(null)
        }}
        title={text(`第 ${historyId} 轮制作记录`, `Workflow run ${historyId}`)}
        width={760}
      >
        <div className="space-y-4">
          {history.isPending ? (
            <p role="status">{text('读取中…', 'Loading…')}</p>
          ) : history.isError ? (
            <p role="alert">{text('无法读取，请重新打开', 'Could not load this run; please reopen it')}</p>
          ) : (
            history.data?.stages.map((item) => (
              <details key={item.id} className="rounded-control border border-outline p-3">
                <summary className="cursor-pointer text-sm">
                  {history.data.definition.stages.find((s) => s.id === item.id)?.title} · {label(item.status)}
                </summary>
                <p className="mt-3 whitespace-pre-wrap break-words text-xs">
                  {item.artifact?.content || item.error || text('无产物', 'No output')}
                </p>
              </details>
            ))
          )}
        </div>
      </Modal>
      {!!state?.events.length && (
        <details className="rounded-panel border border-outline p-4">
          <summary className="cursor-pointer text-sm font-semibold">
            {text('执行记录', 'Run history')}
          </summary>
          <ol className="mt-3 space-y-2 text-xs text-content-muted">
            {state.events
              .filter((e) => e.kind !== 'poll')
              .map((event) => (
                <li key={event.id}>
                  {new Date(event.createdAt).toLocaleString()} ·{' '}
                  {definition.stages.find((s) => s.id === event.stageId)?.title ?? definition.title} ·{' '}
                  {(
                    {
                      created: '建立流程',
                      continued: '继续执行',
                      stage_started: '开始阶段',
                      checkpoint: '保存进度',
                      stage_waiting: '等待任务',
                      stage_output: '保存产物',
                      approved: '已确认',
                      rewound: '退回阶段',
                      synced: '同步修改',
                      stage_failed: '阶段需处理',
                      pause_requested: '请求暂停',
                      cancelled: '结束流程',
                      interrupted: '重启后暂停',
                    } as Record<string, string>
                  )[event.kind] ?? event.kind}
                </li>
              ))}
          </ol>
        </details>
      )}
      <Modal
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null)
        }}
        title={text('确认流程操作', 'Confirm workflow action')}
        width={440}
        footer={
          <>
            <Button onClick={() => setConfirmation(null)}>{text('取消', 'Cancel')}</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (confirmation) send(confirmation.action, confirmation.stageId)
                setConfirmation(null)
              }}
            >
              {text('确认', 'Confirm')}
            </Button>
          </>
        }
      >
        <p className="text-sm">{confirmation?.message}</p>
      </Modal>
    </div>
  )
}
