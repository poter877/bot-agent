/**
 * 影片风格项目工作台：单一流水线（treatment→…→deliver）的阶段推进、
 * review 确认、渲染进度与成片预览。路由 /film/:id。
 */
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/button'
import { Badge } from '@/shared/ui/badge'
import { Spinner } from '@/shared/ui/spinner'
import { filmApi, filmQueries, type FilmStageState } from '@/entities/film/model'
import { toastError } from '@/shared/lib/errors'
import { cn } from '@/shared/lib/cn'
import { Check, Play, RotateCw } from 'lucide-react'

const STAGE_LABELS: Record<string, { zh: string; en: string }> = {
  treatment: { zh: '导演阐述', en: 'Treatment' },
  style_frames: { zh: '风格定妆帧', en: 'Style frames' },
  script: { zh: '旁白与字幕', en: 'Script' },
  timeline: { zh: '时间线', en: 'Timeline' },
  score: { zh: '配乐与拟音', en: 'Score' },
  build: { zh: '影片工程', en: 'Build' },
  render: { zh: '渲染合成', en: 'Render' },
  deliver: { zh: '交付', en: 'Deliver' },
}

function stageLabel(id: string, language: string) {
  const l = STAGE_LABELS[id]
  return language === 'zh' ? l?.zh ?? id : l?.en ?? id
}

const statusTone: Record<string, 'default' | 'brand' | 'success' | 'error' | 'info' | 'warning' | undefined> = {
  pending: 'default',
  running: 'info',
  review: 'brand',
  waiting: 'warning',
  completed: 'success',
  failed: 'error',
}

export function FilmWorkbenchPage() {
  const { id } = useParams()
  const projectId = Number(id)
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const language = i18n.language?.startsWith('zh') ? 'zh' : 'en'

  const projectQuery = useQuery(filmQueries.project(projectId))
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['film', 'project', projectId] })

  const startMutation = useMutation({
    mutationFn: () => filmApi.start(projectId),
    onSuccess: invalidate,
    onError: (e) => toastError(e),
  })
  const approveMutation = useMutation({
    mutationFn: () => filmApi.approve(projectId),
    onSuccess: invalidate,
    onError: (e) => toastError(e),
  })
  const retryMutation = useMutation({
    mutationFn: () => filmApi.retry(projectId),
    onSuccess: invalidate,
    onError: (e) => toastError(e),
  })

  if (projectQuery.isError) {
    return (
      <div className="flex h-full items-center justify-center bg-app p-8">
        <div className="dim">{(projectQuery.error as Error)?.message || t('errors.unknown')}</div>
      </div>
    )
  }
  if (projectQuery.isPending || !projectQuery.data) {
    return (
      <div className="flex h-full items-center justify-center bg-app">
        <Spinner size={22} />
      </div>
    )
  }

  const project = projectQuery.data
  const run = project.run
  const busy = startMutation.isPending || approveMutation.isPending || retryMutation.isPending

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-app px-7 pt-5 pb-12">
      {/* 头部 */}
      <div className="flex flex-wrap items-center gap-3 pb-4">
        <h1 className="text-xl font-[650] tracking-[-0.02em] text-content">{project.title}</h1>
        <Badge tone="brand">{project.style.cn}</Badge>
        <Badge>{project.style.renderProfile === '3d' ? '3D' : project.style.renderProfile === 'shader' ? 'Shader' : '2D'}</Badge>
        <Badge>{project.style.category_cn}</Badge>
        <span className="text-xs text-content-subtle">
          {language === 'zh' ? project.style.line_cn : project.style.line}
        </span>
        <div className="ml-auto flex gap-2">
          {!run || run.status === 'paused' ? (
            <Button variant="primary" loading={busy} onClick={() => startMutation.mutate()}>
              <Play size={13} /> {language === 'zh' ? '开始制作' : 'Start'}
            </Button>
          ) : null}
          {run?.status === 'review' ? (
            <Button variant="primary" loading={busy} onClick={() => approveMutation.mutate()}>
              <Check size={13} /> {language === 'zh' ? '确认本阶段' : 'Approve'}
            </Button>
          ) : null}
          {run && ['failed', 'waiting'].includes(run.status) ? (
            <Button loading={busy} onClick={() => retryMutation.mutate()}>
              <RotateCw size={13} /> {language === 'zh' ? '重试本阶段' : 'Retry'}
            </Button>
          ) : null}
        </div>
      </div>

      {/* 成片（渲染完成后） */}
      {project.render?.status === 'completed' && project.render.videoUrl && (
        <section className="mb-5 rounded-panel border border-outline bg-surface p-4 shadow-card">
          <h2 className="mb-3 text-sm font-bold text-content">{language === 'zh' ? '成片' : 'Final film'}</h2>
          <video controls playsInline className="max-h-[420px] w-full rounded-control bg-media-surface" src={project.render.videoUrl} poster={project.render.posterUrl ?? undefined} />
          {project.render.posterUrl && (
            <a className="btn btn-sm mt-3" href={project.render.videoUrl} download>
              {language === 'zh' ? '下载成片' : 'Download film'}
            </a>
          )}
        </section>
      )}

      {/* 流水线阶段 */}
      <section className="flex flex-col gap-2.5">
        {run ? (
          run.stages.map((stage, idx) => (
            <StageCard
              key={stage.id}
              stage={stage}
              idx={idx}
              projectId={projectId}
              language={language}
              expanded={idx === run.cursor || (!stage.artifact && idx < run.cursor)}
            />
          ))
        ) : (
          <p className="text-sm text-content-muted">
            {language === 'zh' ? '尚未开始制作。点击「开始制作」进入导演阐述阶段。' : 'Not started. Click Start to begin with the treatment.'}
          </p>
        )}
        {run?.error && <p className="text-sm text-danger">{run.error}</p>}
      </section>
    </div>
  )
}

function StageCard({
  stage,
  idx,
  projectId,
  language,
  expanded,
}: {
  stage: FilmStageState
  idx: number
  projectId: number
  language: string
  expanded: boolean
}) {
  const [open, setOpen] = useState(expanded)
  useEffect(() => {
    if (expanded) setOpen(true)
  }, [expanded])

  const label = stageLabel(stage.id, language)
  return (
    <div
      className={cn(
        'rounded-panel border bg-surface shadow-card',
        stage.status === 'review' ? 'border-brand' : 'border-outline',
      )}
    >
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2.5 border-none bg-transparent px-4 py-3 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="w-7 shrink-0 text-center font-code text-xs text-content-subtle">{String(idx + 1).padStart(2, '0')}</span>
        <span className="text-sm font-semibold text-content">{label}</span>
        <Badge tone={statusTone[stage.status]}>
          {stage.status === 'running' ? <Spinner size={11} /> : null}
          {stage.status}
        </Badge>
        {stage.artifact && <span className="min-w-0 flex-1 truncate text-xs text-content-muted">{stage.artifact.summary}</span>}
      </button>
      {open && stage.artifact && (
        <div className="border-t border-outline px-4 py-3">
          <pre className="max-h-[420px] overflow-auto rounded-control bg-elevated p-3 font-code text-xs whitespace-pre-wrap text-content-secondary">
            {stage.artifact.content}
          </pre>
          {stage.artifact.checks.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-xs text-content-muted">
              {stage.artifact.checks.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
          {stage.error && <p className="mt-2 text-xs text-danger">{stage.error}</p>}
        </div>
      )}
      {open && !stage.artifact && stage.error && (
        <div className="border-t border-outline px-4 py-3 text-xs text-danger">{stage.error}</div>
      )}
      {open && stage.id === 'build' && stage.status !== 'pending' && (
        <BuildAgentMonitor projectId={projectId} active={stage.status === 'running'} language={language} />
      )}
    </div>
  )
}

/** build 阶段的 agent 日志流 + 最新自检帧（增量拉取，运行中 1.5s 轮询） */
function BuildAgentMonitor({
  projectId,
  active,
  language,
}: {
  projectId: number
  active: boolean
  language: string
}) {
  const [lines, setLines] = useState<string[]>([])
  const [frame, setFrame] = useState<string | null>(null)
  const offsetRef = useRef(0)
  const boxRef = useRef<HTMLPreElement>(null)

  useQuery({
    queryKey: ['film', 'build-log', projectId],
    queryFn: async ({ signal }) => {
      const res = await filmApi.buildLog(projectId, offsetRef.current, signal)
      // 日志被重置（重试重建）→ 清空已积累内容，从头读
      if (res.size < offsetRef.current) {
        offsetRef.current = 0
        setLines([])
      }
      if (res.content) {
        offsetRef.current = res.nextOffset
        setLines((prev) => [...prev, ...res.content.replace(/\n$/, '').split('\n')])
      }
      if (res.latestFrame) setFrame(res.latestFrame)
      return res
    },
    refetchInterval: active ? 1500 : false,
    refetchIntervalInBackground: true,
    staleTime: 0,
  })

  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  return (
    <div className="border-t border-outline px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-xs text-content-muted">
        {active && <Spinner size={11} />}
        {language === 'zh' ? 'Agent 工程日志' : 'Agent build log'}
        {active && (language === 'zh' ? '（实时）' : ' (live)')}
      </div>
      <div className="flex gap-3">
        <pre
          ref={boxRef}
          className="h-60 min-w-0 flex-1 overflow-auto rounded-control bg-elevated p-3 font-code text-xs leading-relaxed whitespace-pre-wrap text-content-secondary"
        >
          {lines.length > 0 ? lines.join('\n') : active ? '…' : ''}
        </pre>
        {frame && (
          <img
            src={frame}
            alt={language === 'zh' ? '最新自检帧' : 'Latest self-check frame'}
            className="h-60 w-auto max-w-[45%] rounded-control border border-outline object-contain"
          />
        )}
      </div>
    </div>
  )
}

