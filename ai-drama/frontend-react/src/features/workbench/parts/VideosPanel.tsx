/**
 * 视频生产面板（三栏，宽度可拖拽持久化）：
 * 左：分镜任务列表（筛选/多选/状态徽章）；中：分镜检查器（描述/绑定参考/@提及提示词）；
 * 右：播放器 + 视频历史 + 时长参数 + 常驻生成按钮。
 * 生成受理与终态由聚合 jobs 查询统一同步。
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { mapError, toastError } from '@/shared/lib/errors'
import { toast } from 'sonner'
import { thumbOf, thumbFallback, posterOf } from '@/shared/lib/media'
import { MentionTextarea, type MentionOption } from '@/shared/ui/MentionTextarea'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Input, Textarea } from '@/shared/ui/input'
import { taskApi, type SysTask } from '@/entities/generation-task/api'
import { storyboardApi } from '@/entities/storyboard/api'
import { usePreferences } from '@/shared/config/preferences'
import { useWorkbench } from '../WorkbenchProvider'
import { useWorkbenchUi } from '../EpisodeWorkbenchPage'
import { useWorkbenchStore } from '../workbench-store'
import {
  assetImageSrcOf,
  clampVideoCol,
  formatHistoryTime,
  storyboardScene,
  taskCreatedAt,
  taskVideoPath,
  VIDEO_COL_DEFAULTS,
  type VideoTaskState,
} from '../workbench-lib'
import { cn } from '@/shared/lib/cn'

// 原 .video-task-metric/.video-task-status 徽章（+ is-done/is-pending/is-failed 状态；button 形态带筛选光圈）
const metricClass =
  'inline-flex items-center gap-[5px] min-h-[22px] rounded-full border border-outline bg-track px-2 text-[11px] font-[750] whitespace-nowrap text-content-muted'
const metricStateClass: Record<string, string> = {
  done: 'border-success-soft bg-success-soft text-success',
  pending: 'border-[color:var(--hb-brand-glow)] bg-brand-soft text-brand-content',
  failed: 'border-warning-soft bg-warning-soft text-warning',
}
// 行级状态背景（原 .video-task-row.is-pending/.is-failed；is-done/ready 无行级样式）
const rowStateClass: Record<VideoTaskState, string> = {
  done: '',
  pending: 'bg-hover-overlay',
  failed: 'bg-danger-soft',
  ready: '',
}
// 行内状态文字色（原 .video-task-state.is-* / .video-task-status.is-*）
const stateTextClass: Record<VideoTaskState, string> = {
  done: 'text-success',
  pending: 'text-brand-content',
  failed: 'text-warning',
  ready: '',
}
// 原 .shot-check + .video-task-check 合成（后定义者覆盖 bg/border）+ :global(.on)
const shotCheckClass =
  'absolute right-[5px] top-[5px] z-[2] inline-flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-[4px] border-[1.5px] border-white/55 bg-black/45 text-on-action transition-colors duration-150 hover:border-brand'
// 原 .field-label 覆盖：legacy 基样式（12px/550/text-1）已被下列 utilities 全部覆盖，直接内联
const fieldLabelClass = 'text-[12px] font-medium text-content-secondary'

export function VideosPanel() {
  const wb = useWorkbench()
  const { t } = useTranslation()
  const prefs = usePreferences()

  const selectedSbId = useWorkbenchStore((s) => s.selectedStoryboardId)
  const selectStoryboard = useWorkbenchStore((s) => s.selectStoryboard)
  const videoListFilter = useWorkbenchStore((s) => s.videoListFilter)
  const setVideoListFilter = useWorkbenchStore((s) => s.setVideoListFilter)
  const videoSelectMode = useWorkbenchStore((s) => s.videoSelectMode)
  const toggleVideoSelectMode = useWorkbenchStore((s) => s.toggleVideoSelectMode)
  const selectedVideoSbIds = useWorkbenchStore((s) => s.selectedVideoSbIds)
  const toggleVideoSbSelect = useWorkbenchStore((s) => s.toggleVideoSbSelect)
  const setSelectedVideoSbIds = useWorkbenchStore((s) => s.setSelectedVideoSbIds)

  const selectedSb = useMemo(
    () => wb.sbs.find((s) => s.id === selectedSbId) ?? wb.sbs[0] ?? null,
    [wb.sbs, selectedSbId],
  )
  // 选中分镜被刷新后若仍存在则保持；不存在则回落首个（effect 中同步，避免渲染期 setState）
  useEffect(() => {
    if (wb.sbs.length && selectedSb && !wb.sbs.some((s) => s.id === selectedSb.id)) {
      selectStoryboard(wb.sbs[0]!.id)
    }
    if (!selectedSbId && wb.sbs.length) {
      selectStoryboard(wb.sbs[0]!.id)
    }
  }, [wb.sbs, selectedSb, selectedSbId, selectStoryboard])

  const rows = useMemo(() => {
    return wb.sbs.map((sb, index) => {
      const state = wb.videoStateOf(sb)
      const sceneName = wb.getSceneName(sb)
      return {
        id: sb.id,
        index,
        storyboard: sb,
        title: sb.description || t('episode.vid.shotN', { n: String(index + 1).padStart(2, '0') }),
        meta: sceneName,
        duration: Number.isFinite(Number(sb.duration)) ? Number(sb.duration || 5) : 5,
        state,
        error: state === 'failed' ? wb.videoFailMessages[sb.id] ?? '' : '',
      }
    })
  }, [wb, t])
  const filteredRows = videoListFilter ? rows.filter((r) => r.state === videoListFilter) : rows
  const doneCount = rows.filter((r) => r.state === 'done').length
  const failedCount = rows.filter((r) => r.state === 'failed').length

  function onRowClick(sb: typeof rows[number]['storyboard']) {
    if (videoSelectMode) toggleVideoSbSelect(sb.id)
    else selectStoryboard(sb.id)
  }

  function batchVideos() {
    const useSelection = videoSelectMode && selectedVideoSbIds.length
    const pool = useSelection
      ? wb.sbs.filter((s) => selectedVideoSbIds.includes(s.id))
      : wb.sbs.filter((s) => !(s.videoUrl || s.composedVideoUrl))
    wb.openBatchVideoConfirm(pool)
  }

  // ===== 三栏拖拽 =====
  const videoLeftW = prefs.videoColumns.left
  const videoRightW = prefs.videoColumns.right
  function startColDrag(which: 'left' | 'right', e: React.PointerEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    const target = e.currentTarget as HTMLElement
    const startX = e.clientX
    const startW = which === 'left' ? videoLeftW : videoRightW
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const w = clampVideoCol(which, which === 'left' ? startW + dx : startW - dx)
      prefs.setVideoColumns(
        which === 'left' ? { left: w, right: videoRightW } : { left: videoLeftW, right: w },
      )
    }
    const onUp = () => {
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onUp)
      document.body.classList.remove('is-video-col-dragging')
      // 原 :global(body.is-video-col-dragging) 全局规则（随 CSS Modules 删除），改为拖拽期直接置样式
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.classList.add('is-video-col-dragging')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onUp)
    target.setPointerCapture?.(e.pointerId)
  }

  if (!wb.sbs.length) {
    return (
      <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-3 pt-2.5 pb-3">
        <SectionBar
          left={
            <>
              <span className="text-content-subtle" style={{ fontSize: 12 }}>{t('episode.prod.videos')}</span>
              <Badge mono>{t('episode.sb.segmentStat', { n: wb.sbs.length, dur: wb.totalDuration })}</Badge>
              <Badge mono title={t('episode.vid.aspectRatio')}>{wb.dramaAspectRatio}</Badge>
            </>
          }
        />
        <div className="flex flex-1 flex-col items-center justify-center gap-2.5 min-h-[300px] animate-fade-in p-[46px]">
          <div className="mb-2 flex h-[72px] w-[72px] items-center justify-center rounded-[22px] border border-outline bg-[var(--hb-bg-1)] text-brand shadow-raise">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
              <rect x="2" y="2" width="20" height="20" rx="2.5" /><line x1="7" y1="8" x2="7" y2="16" /><line x1="10" y1="8" x2="10" y2="16" /><line x1="13" y1="8" x2="13" y2="16" />
            </svg>
          </div>
          <div className="text-[22px] font-bold font-display text-content">{t('episode.sb.emptyTitle')}</div>
          <div className="max-w-[420px] text-center text-[13px] leading-[1.8] text-content-muted">{t('episode.sb.emptyDesc')}</div>
          <div className="mb-2 text-[12px] text-content-muted">
            {t('episode.vid.lockedModel')}{wb.effectiveVideoModelLabel}
          </div>
          <button type="button" className={buttonVariants({ variant: 'primary' })} disabled={wb.agentRunning} onClick={wb.doBreakdown}>
            {wb.agentRunning && wb.agentRunningType === 'storyboard_breaker' ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            )}
            {t('episode.sb.startBreak')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-3 pt-2.5 pb-3">
      <SectionBar
        left={
          <>
            <span className="text-content-subtle" style={{ fontSize: 12 }}>{t('episode.prod.videos')}</span>
            <Badge mono>{t('episode.sb.segmentStat', { n: wb.sbs.length, dur: wb.totalDuration })}</Badge>
            <Badge mono title={t('episode.vid.aspectRatio')}>{wb.dramaAspectRatio}</Badge>
          </>
        }
        actions={
          <>
            <button type="button" className={buttonVariants({ size: 'sm' })} disabled={wb.agentRunning} onClick={wb.doBreakdown}>
              {wb.agentRunning && wb.agentRunningType === 'storyboard_breaker' ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
              )}
              {wb.sbs.length ? t('episode.sb.rebreak') : t('episode.sb.startBreak')}
            </button>
            <button
              type="button"
              className={buttonVariants({ size: 'sm' })}
              disabled={wb.batchPrompt.running || !wb.sbs.length}
              onClick={() => void wb.batchVideoPrompts()}
            >
              {wb.batchPrompt.running ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" />
                </svg>
              )}
              {wb.batchPrompt.running
                ? t('episode.sb.promptProgress', { done: wb.batchPrompt.completed, total: wb.batchPrompt.total })
                : videoSelectMode && selectedVideoSbIds.length
                  ? t('episode.sb.promptSelected', { n: selectedVideoSbIds.length })
                  : t('episode.sb.batchPrompts')}
            </button>
            {!!failedCount && (
              <button type="button" className={cn(buttonVariants({ size: 'sm' }), 'text-warning')} onClick={wb.retryFailedVideos}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
                {t('episode.vid.retryFailed', { n: failedCount })}
              </button>
            )}
            <button
              type="button"
              className={cn(buttonVariants({ size: 'sm' }), videoSelectMode && 'bg-brand-soft text-brand-content')}
              onClick={toggleVideoSelectMode}
            >
              {videoSelectMode ? t('episode.vid.selectDone', { n: selectedVideoSbIds.length }) : t('episode.vid.select')}
            </button>
            <button type="button" className={buttonVariants({ size: 'sm' })} onClick={batchVideos}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
              </svg>
              {videoSelectMode && selectedVideoSbIds.length
                ? t('episode.vid.batchSelected', { n: selectedVideoSbIds.length })
                : t('episode.vid.batchVideos')}
            </button>
          </>
        }
      />

      <div
        className="relative grid flex-1 grid-cols-[var(--vleft,236px)_minmax(0,1fr)] gap-0 min-h-0 overflow-hidden rounded-panel border border-outline bg-surface max-860:grid-cols-1 max-860:overflow-y-auto"
        style={{ '--vleft': `${videoLeftW}px`, '--vright': `${videoRightW}px` } as React.CSSProperties}
      >
        {/* ===== 左：任务列表 ===== */}
        <section className="flex min-h-0 flex-col overflow-hidden rounded-none border-0 bg-surface">
          <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 border-b border-outline px-3 py-2.5 max-1080:flex-col max-1080:items-start">
            <div>
              <div className="text-[13px] leading-[1.2] font-[850] text-content">{t('episode.vid.listTitle')}</div>
              <div className="mt-[3px] text-[11px] leading-[1.35] text-content-subtle">
                {videoListFilter
                  ? t('episode.vid.listMetaFiltered', { n: filteredRows.length, total: rows.length })
                  : t('episode.vid.listMeta', { n: filteredRows.length })}
              </div>
            </div>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5 max-1080:ml-0 max-1080:w-full max-1080:justify-start">
              {(['pending', 'done', 'failed'] as const).map((key) => {
                const label = key === 'pending' ? t('episode.vid.metricPending', { n: wb.pendingVideoIds.length })
                  : key === 'done' ? t('episode.vid.metricDone', { n: doneCount })
                    : t('episode.vid.metricFailed', { n: failedCount })
                return (
                  <button
                    key={key}
                    type="button"
                    className={cn(
                      metricClass,
                      'cursor-pointer transition-shadow duration-150',
                      metricStateClass[key],
                      videoListFilter === key ? 'shadow-[0_0_0_2px_var(--hb-brand)]' : 'hover:shadow-[0_0_0_2px_var(--hb-bg-hover)]',
                    )}
                    onClick={() => setVideoListFilter(videoListFilter === key ? '' : key)}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>

          {videoSelectMode && (
            <div className="mx-3 mb-2.5 flex gap-1.5">
              <button
                type="button"
                className="flex-1 cursor-pointer rounded-md border-none bg-elevated px-0 py-[5px] text-center text-[11px] font-semibold whitespace-nowrap text-content-muted transition-colors duration-150 hover:bg-brand-soft hover:text-brand-content hover:no-underline"
                onClick={() => setSelectedVideoSbIds(wb.sbs.map((sb) => sb.id))}
              >
                {t('episode.sb.selectAll')}
              </button>
              <button
                type="button"
                className="flex-1 cursor-pointer rounded-md border-none bg-elevated px-0 py-[5px] text-center text-[11px] font-semibold whitespace-nowrap text-content-muted transition-colors duration-150 hover:bg-brand-soft hover:text-brand-content hover:no-underline"
                onClick={() => setSelectedVideoSbIds(wb.sbs.filter((sb) => !(sb.videoUrl || sb.composedVideoUrl)).map((sb) => sb.id))}
              >
                {t('episode.vid.selectMissing')}
              </button>
              <button
                type="button"
                className="flex-1 cursor-pointer rounded-md border-none bg-elevated px-0 py-[5px] text-center text-[11px] font-semibold whitespace-nowrap text-content-muted transition-colors duration-150 hover:bg-brand-soft hover:text-brand-content hover:no-underline"
                onClick={() => setSelectedVideoSbIds([])}
              >
                {t('episode.sb.clear')}
              </button>
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {filteredRows.map((task) => {
              const sb = task.storyboard
              const vid = sb.videoUrl || sb.composedVideoUrl
              const rowActive = !videoSelectMode && selectedSb?.id === task.id
              const rowSelected = videoSelectMode && selectedVideoSbIds.includes(task.id)
              const checked = selectedVideoSbIds.includes(task.id)
              return (
                <div
                  key={task.id}
                  className={cn(
                    'grid grid-cols-[56px_minmax(0,1fr)_auto] items-center gap-2 border-t border-outline px-2 py-1.5 transition-[background,border-color] duration-150 ease-app first:border-t-0 hover:bg-hover-overlay focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-brand max-1080:grid-cols-[56px_minmax(0,1fr)]',
                    rowStateClass[task.state],
                    rowActive && 'bg-active-overlay shadow-[inset_0_0_0_1.5px_var(--hb-text-primary),0_0_0_3px_var(--hb-bg-hover)]',
                    rowSelected && 'bg-active-overlay shadow-[inset_0_0_0_1.5px_var(--hb-text-primary)]',
                  )}
                  role="button"
                  tabIndex={0}
                  onClick={() => onRowClick(sb)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onRowClick(sb))}
                >
                  <div className="relative aspect-video w-14 overflow-hidden rounded-item border border-outline bg-elevated">
                    {videoSelectMode && (
                      <span className={cn(shotCheckClass, checked && 'border-brand bg-brand')}>
                        {checked && (
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </span>
                    )}
                    {vid ? (
                      <video
                        src={`/${vid}`}
                        poster={posterOf(`/${vid}`) || undefined}
                        preload="none"
                        playsInline
                        muted
                        tabIndex={-1}
                        className="block h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-content-subtle">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                          <polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                        </svg>
                      </div>
                    )}
                    <span className="absolute left-[3px] top-[3px] rounded-[3px] bg-black/[0.56] px-1 font-code text-[9px] font-extrabold text-white">
                      #{String(task.index + 1).padStart(2, '0')}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <strong className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] leading-[1.35] text-content">{task.title}</strong>
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-[5px] overflow-hidden whitespace-nowrap text-[10.5px] text-content-subtle">
                      <span className={cn('inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold whitespace-nowrap', stateTextClass[task.state])}>
                        <i
                          className={cn(
                            'h-[7px] w-[7px] shrink-0 rounded-full bg-sunken',
                            task.state === 'done' && 'bg-success',
                            task.state === 'pending' && 'bg-brand shadow-[0_0_0_3px_var(--hb-brand-glow)]',
                          )}
                        />
                        {stateLabel(t, task.state)}
                      </span>
                      <span className="text-content-subtle opacity-50">·</span>
                      <span>{task.duration}s</span>
                      {task.meta && (
                        <>
                          <span className="text-content-subtle opacity-50">·</span>
                          <span className="truncate text-content-muted">{task.meta}</span>
                        </>
                      )}
                    </div>
                    {task.error && (
                      <div className="mt-[5px] text-[11px] leading-[1.45] text-danger" title={task.error}>
                        {mapError(task.error)}
                        {wb.videoModerationHint(task.error) && (
                          <div className="mt-[3px] font-semibold text-brand-content">{wb.videoModerationHint(task.error)}</div>
                        )}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className={cn(buttonVariants({ size: 'icon' }), 'size-[30px] min-w-[30px] min-h-[30px] h-6 w-6 min-w-0 justify-self-end self-center p-0 max-1080:justify-self-start')}
                    title={actionLabel(t, task.state)}
                    disabled={task.state === 'pending'}
                    onClick={(e) => {
                      e.stopPropagation()
                      void wb.genVid(sb)
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                    </svg>
                  </button>
                </div>
              )
            })}
          </div>
        </section>

        {/* ===== 中 + 右 ===== */}
        {selectedSb && (
          <SelectedInspector sb={selectedSb} startColDrag={startColDrag} />
        )}
      </div>
    </div>
  )
}

function SectionBar({ left, actions }: { left: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-[7px] flex-wrap">
      {left}
      {actions && <div className="ml-auto flex gap-1">{actions}</div>}
    </div>
  )
}

function stateLabel(t: (k: string) => string, state: VideoTaskState): string {
  if (state === 'done') return t('episode.status.done')
  if (state === 'pending') return t('episode.status.generating')
  if (state === 'failed') return t('episode.status.failed')
  return t('episode.status.todo')
}

function actionLabel(t: (k: string) => string, state: VideoTaskState): string {
  if (state === 'done') return t('episode.asset.regen')
  if (state === 'pending') return t('episode.asset.generating')
  return t('episode.asset.generate')
}

/** 选中分镜的检查器 + 播放器（中右两栏） */
function SelectedInspector({
  sb,
  startColDrag,
}: {
  sb: ReturnType<typeof useWorkbench>['sbs'][number]
  startColDrag: (which: 'left' | 'right', e: React.PointerEvent) => void
}) {
  const wb = useWorkbench()
  const ui = useWorkbenchUi()
  const { t } = useTranslation()
  const prefs = usePreferences()
  const setProdTab = useWorkbenchStore((s) => s.setProdTab)

  // 分镜序号（任务列表中的位置）
  const index = wb.sbs.findIndex((s) => s.id === sb.id)

  // ===== 字段草稿（blur 提交；本地值与查询数据解耦避免输入被刷新打断） =====
  const [descDraft, setDescDraft] = useState(sb.description || '')
  const [atmoDraft, setAtmoDraft] = useState(sb.atmosphere || '')
  const [promptDraft, setPromptDraft] = useState(sb.videoPrompt || '')
  useEffect(() => {
    setDescDraft(sb.description || '')
    setAtmoDraft(sb.atmosphere || '')
  }, [sb.id, sb.description, sb.atmosphere])
  // 提示词基线跟随：仅当无本地编辑时同步（@提及 commit 即提交，故始终视为已保存态）
  useEffect(() => {
    setPromptDraft(sb.videoPrompt || '')
  }, [sb.id, sb.videoPrompt])

  // ===== 参考素材绑定 =====
  const bindableAssets = useMemo(() => {
    const out: Array<{ key: string; id: number; kind: 'character' | 'scene' | 'prop'; typeLabel: string; name: string; meta: string; imageUrl: string; ready: boolean; bound: boolean }> = []
    for (const char of wb.visualChars) {
      out.push({
        key: `character-${char.id}`,
        id: char.id,
        kind: 'character',
        typeLabel: t('common.role'),
        name: char.name || t('episode.asset.unnamedChar'),
        meta: char.role || t('episode.asset.charPortrait'),
        imageUrl: char.imageUrl,
        ready: !!char.imageUrl,
        bound: sb.characterIds.includes(char.id),
      })
    }
    for (const scene of wb.scenes) {
      out.push({
        key: `scene-${scene.id}`,
        id: scene.id,
        kind: 'scene',
        typeLabel: t('common.scene'),
        name: `${scene.location} · ${scene.time || t('episode.asset.noTime')}`,
        meta: scene.time || t('episode.asset.sceneImage'),
        imageUrl: scene.imageUrl,
        ready: !!scene.imageUrl,
        bound: sb.sceneId === scene.id,
      })
    }
    for (const prop of wb.props) {
      out.push({
        key: `prop-${prop.id}`,
        id: prop.id,
        kind: 'prop',
        typeLabel: t('common.prop'),
        name: prop.name || t('episode.asset.unnamedProp'),
        meta: prop.type || t('episode.asset.propSingleImage'),
        imageUrl: prop.imageUrl,
        ready: !!prop.imageUrl,
        bound: sb.propIds.includes(prop.id),
      })
    }
    return out
  }, [wb.visualChars, wb.scenes, wb.props, sb, t])
  const boundRefAssets = bindableAssets.filter((a) => a.bound)

  const REF_KINDS = [
    { kind: 'character' as const, label: t('common.role') },
    { kind: 'scene' as const, label: t('common.scene') },
    { kind: 'prop' as const, label: t('common.prop') },
  ]

  // ===== @提及候选 =====
  const mentionOptions = useMemo<MentionOption[]>(() => {
    const scene = storyboardScene(sb, wb.scenes)
    return [
      ...wb.visualChars
        .filter((c) => sb.characterIds.includes(c.id))
        .map((c) => ({
          label: c.name,
          value: c.name,
          kind: 'character',
          group: t('common.role'),
          image: c.imageUrl ? thumbOf(assetImageSrcOf(c.imageUrl)) : undefined,
        })),
      ...(scene
        ? [
            {
              label: `${scene.location} · ${scene.time || t('episode.asset.noTime')}`,
              value: scene.location,
              kind: 'scene',
              group: t('common.scene'),
              image: scene.imageUrl ? thumbOf(assetImageSrcOf(scene.imageUrl)) : undefined,
            },
          ]
        : []),
      ...wb.props
        .filter((p) => sb.propIds.includes(p.id))
        .map((p) => ({
          label: p.name,
          value: p.name,
          kind: 'prop',
          group: t('common.prop'),
          image: p.imageUrl ? thumbOf(assetImageSrcOf(p.imageUrl)) : undefined,
        })),
    ]
  }, [sb, wb.visualChars, wb.scenes, wb.props, t])

  // ===== 视频历史 =====
  const [history, setHistory] = useState<SysTask[]>([])
  const [previewVideoUrl, setPreviewVideoUrl] = useState('')
  const currentVideo = sb.videoUrl || sb.composedVideoUrl || ''
  useEffect(() => {
    setPreviewVideoUrl('')
    let cancelled = false
    void (async () => {
      try {
        const rows = await taskApi.list({ type: 'video', storyboard_id: sb.id })
        if (cancelled) return
        setHistory(
          (Array.isArray(rows) ? rows : [])
            .filter((x) => x.status === 'completed' && taskVideoPath(x))
            .sort((a, b) => taskCreatedAt(b).localeCompare(taskCreatedAt(a))),
        )
      } catch {
        if (!cancelled) setHistory([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sb.id, currentVideo])

  const isCurrentVideo = (x: SysTask) => {
    const p = taskVideoPath(x)
    return !!p && p === currentVideo
  }

  async function setAsMainVideo() {
    try {
      await storyboardApi.update(sb.id, { video_url: previewVideoUrl })
      await wb.refresh()
      toast.success(t('episode.vid.setMainDone'))
    } catch (err) {
      toastError(err, { fallback: 'episode.vid.setMainFailed' })
    }
  }

  async function removeHistoryVideo(x: SysTask) {
    try {
      await taskApi.del(x.id)
      setHistory((prev) => prev.filter((y) => y.id !== x.id))
      if (previewVideoUrl === taskVideoPath(x)) setPreviewVideoUrl('')
      toast.success(t('episode.vid.historyDeleted'))
    } catch (err) {
      toastError(err, { fallback: 'common.deleteFailed' })
    }
  }

  const state = wb.videoStateOf(sb)
  const activeVideo = previewVideoUrl || currentVideo

  return (
    <>
      {/* 中列：检查器 */}
      <div className="flex min-h-0 min-w-0 max-860:flex-none max-860:flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-surface px-4 pt-3.5 pb-4 max-860:flex-none max-860:overflow-visible">
          <div className="grid grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] items-start gap-4 max-1080:grid-cols-1">
            <section className="flex flex-col gap-[7px]">
              <span className="text-[12px] font-bold text-content">{t('episode.sb.descSection')}</span>
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabelClass}>
                  {t('episode.sb.descLabel')} <span className="text-content-subtle">({t('episode.sb.descHint')})</span>
                </span>
                <Textarea
                  value={descDraft}
                  onChange={(e) => setDescDraft(e.target.value)}
                  onBlur={() => wb.updateField(sb, 'description', descDraft)}
                  rows={7}
                  placeholder={t('episode.sb.descPlaceholder')}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabelClass}>{t('episode.sb.atmosphere')}</span>
                <Textarea
                  value={atmoDraft}
                  onChange={(e) => setAtmoDraft(e.target.value)}
                  onBlur={() => wb.updateField(sb, 'atmosphere', atmoDraft)}
                  rows={2}
                  placeholder={t('episode.sb.atmospherePlaceholder')}
                />
              </label>
            </section>

            <section className="flex flex-col gap-[7px]">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-bold text-content">{t('episode.ref.title')}</span>
                <Badge mono>
                  {t('episode.ref.boundCount', { bound: boundRefAssets.length, total: bindableAssets.length })}
                </Badge>
              </div>
              {/* 嵌入中栏：高度封顶内部滚动（原 .is-embedded + .video-main-grid 上下文规则） */}
              <div className="flex max-h-[300px] min-h-0 flex-col gap-[5px] overflow-y-auto p-0">
                {REF_KINDS.map((g, gi) => {
                  const items = bindableAssets.filter((a) => a.kind === g.kind)
                  if (!items.length) return null
                  return (
                    <div key={g.kind} className={cn('grid grid-cols-2 gap-[5px]', gi > 0 && 'mt-1')}>
                      <div className="col-span-full px-0.5 text-[11px] font-semibold tracking-[0.02em] text-content-subtle">{g.label}</div>
                      {items.map((asset) => {
                        const src = assetImageSrcOf(asset.imageUrl)
                        return (
                          <div
                            key={asset.key}
                            className={cn(
                              'grid grid-cols-[30px_minmax(0,1fr)] items-center gap-2 rounded-control border bg-surface px-[7px] py-[5px] transition-[border-color,opacity] duration-150 ease-app',
                              asset.bound
                                ? 'border-brand bg-brand-soft hover:border-brand'
                                : 'border-outline bg-transparent opacity-70 hover:border-brand hover:opacity-100',
                            )}
                            title={asset.bound ? t('episode.ref.clickRemove') : t('episode.ref.clickAdd')}
                            onClick={() => {
                              if (asset.kind === 'scene') wb.toggleSceneBind(sb, asset.id)
                              else if (asset.kind === 'character') wb.toggleStoryboardCharacter(sb, asset.id)
                              else wb.toggleStoryboardProp(sb, asset.id)
                            }}
                          >
                            <button
                              type="button"
                              className="flex aspect-square w-[30px] items-center justify-center overflow-hidden rounded-item border border-outline bg-elevated text-[10px] font-extrabold text-content-subtle disabled:cursor-default"
                              disabled={!asset.ready}
                              onClick={(e) => {
                                e.stopPropagation()
                                if (asset.ready) ui.openImage(src, `${asset.name} ${asset.typeLabel}`)
                              }}
                            >
                              {asset.ready ? (
                                <img
                                  src={thumbOf(src)}
                                  className="previewable-image block h-full w-full object-cover"
                                  loading="lazy"
                                  onError={(e) => thumbFallback(e, src)}
                                  alt=""
                                />
                              ) : (
                                <span>
                                  {asset.kind === 'scene' ? t('episode.ref.shortScene') : asset.kind === 'prop' ? t('episode.ref.shortProp') : t('episode.ref.shortChar')}
                                </span>
                              )}
                            </button>
                            <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                              <span className={cn('max-w-[42%] flex-none overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-bold', asset.bound ? 'text-content' : 'text-content-muted')}>
                                {asset.name}
                              </span>
                              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[10.5px] text-content-subtle">{asset.typeLabel} · {asset.meta}</span>
                              <span className={cn('ml-auto shrink-0 text-[10px] text-content-subtle', asset.bound && asset.ready && 'text-success')}>
                                {asset.bound ? (asset.ready ? t('episode.ref.usable') : t('episode.ref.notReady')) : t('episode.ref.unbound')}
                              </span>
                              {asset.bound && !asset.ready && (
                                <button
                                  type="button"
                                  className="shrink-0 cursor-pointer rounded-item border-none bg-transparent px-0.5 py-0 text-[10.5px] font-semibold text-brand hover:bg-brand-soft"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setProdTab('assets')
                                  }}
                                >
                                  {t('episode.ref.gotoGenerate')}
                                </button>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
                {!bindableAssets.length && (
                  <div className="rounded-control border border-dashed border-outline px-2.5 py-3.5 text-[12px] leading-[1.5] text-content-subtle">{t('episode.ref.empty')}</div>
                )}
              </div>
            </section>
          </div>

          <section className="flex flex-col gap-[7px]">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[13px] font-bold text-brand before:h-[13px] before:w-[3px] before:rounded-[2px] before:bg-brand before:content-['']">
                {t('episode.sb.videoPromptSection')}
              </span>
              <button
                type="button"
                className={buttonVariants({ size: 'sm' })}
                disabled={wb.videoPromptGeneratingIds.includes(sb.id) || wb.batchPrompt.running}
                onClick={() => void wb.genVideoPrompt(sb)}
              >
                {wb.videoPromptGeneratingIds.includes(sb.id) && <Loader2 size={11} className="animate-spin" />}
                {sb.videoPrompt ? t('episode.sb.regenPrompt') : t('episode.sb.aiGenerate')}
              </button>
            </div>
            <MentionTextarea
              value={promptDraft}
              onChange={setPromptDraft}
              onCommit={(v) => wb.updateField(sb, 'video_prompt', v)}
              options={mentionOptions}
              rows={14}
              inputClassName="w-full rounded-control border border-outline-strong bg-input px-3.5 py-[9px] text-form leading-[1.7] text-content tracking-[-0.01em] transition-[border-color,box-shadow,background] duration-150 ease-app placeholder:text-content-subtle hover:border-outline-hover focus:border-brand focus:shadow-focus outline-none min-h-[176px] text-[13px] leading-[1.6]"
              placeholder={t('episode.inspector.videoPromptPlaceholder')}
            />
          </section>
        </div>
      </div>

      {/* 右列：播放器/历史/参数 */}
      <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden border-l border-outline bg-surface-muted max-860:border-l-0 max-860:border-t max-860:border-t-outline">
        <aside className="flex min-h-0 min-w-0 flex-none flex-col border-b border-outline bg-surface">
          <div className="flex min-h-[44px] flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-outline px-3.5 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <div className="whitespace-nowrap text-[13px] font-bold text-content">
                {t('episode.vid.playerTitle', { n: String(index >= 0 ? index + 1 : 0).padStart(2, '0') })}
              </div>
              <span className={cn('justify-self-end self-center', metricClass, metricStateClass[state === 'ready' ? 'pending' : state])}>
                <span
                  className={cn(
                    'h-[7px] w-[7px] shrink-0 rounded-full bg-sunken',
                    state === 'done' && 'bg-success',
                    state === 'pending' && 'bg-brand shadow-[0_0_0_3px_var(--hb-brand-glow)]',
                  )}
                />
                {stateLabel(t, state)}
              </span>
              {!!sb.duration && <span className="whitespace-nowrap text-[11px] text-content-subtle">{sb.duration}s</span>}
            </div>
            {previewVideoUrl && (
              <button type="button" className={buttonVariants({ variant: 'primary', size: 'sm' })} onClick={() => void setAsMainVideo()}>
                {t('episode.vid.setMain')}
              </button>
            )}
            {(previewVideoUrl || currentVideo) && (
              <a href={`/${previewVideoUrl || currentVideo}`} download className={buttonVariants({ size: 'sm' })}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                {t('common.download')}
              </a>
            )}
          </div>
          <div className="flex aspect-video max-h-[220px] flex-none items-center justify-center bg-media-surface">
            {activeVideo ? (
              <video
                key={activeVideo}
                src={`/${activeVideo}`}
                poster={posterOf(`/${activeVideo}`) || undefined}
                controls
                preload="metadata"
                playsInline
                className="block h-full max-h-full w-full max-w-full object-contain"
              />
            ) : (
              <div className="flex w-full flex-col items-center justify-center gap-1.5 px-4 py-3.5 text-center text-content-subtle">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                  <polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                </svg>
                <div className="flex flex-col items-center">
                  <div className="text-[12.5px] font-bold text-content-secondary">
                    {state === 'pending' ? t('episode.vid.emptyGenerating') : t('episode.vid.emptyNoVideo')}
                  </div>
                  <div className="mt-0.5 text-[11px] leading-[1.5]">
                    {state === 'pending' ? t('episode.vid.emptyGeneratingDesc') : t('episode.vid.emptyNoVideoDesc')}
                  </div>
                </div>
                {state !== 'pending' && (
                  <button type="button" className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'mt-1 shrink-0')} onClick={() => void wb.genVid(sb)}>
                    {t('episode.vid.generateVideo')}
                  </button>
                )}
              </div>
            )}
          </div>
        </aside>

        {history.length > 0 && (
          <div className="min-h-0 flex-none border-b border-outline bg-surface px-3 pt-2 pb-2.5">
            <div className="mb-[7px] flex items-center gap-1.5 text-[11px] font-bold text-content-muted">
              <span>{t('episode.vid.history')}</span>
              <span className="rounded-full bg-track px-1.5 text-[10px] font-[750] text-content-subtle">{history.length}</span>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-0.5">
              {history.map((h) => {
                const p = taskVideoPath(h)
                const current = isCurrentVideo(h)
                const viewing = !!previewVideoUrl && previewVideoUrl === p
                return (
                  <div
                    key={h.id}
                    className={cn(
                      'group relative aspect-video w-24 shrink-0 grow-0 basis-auto cursor-pointer overflow-hidden rounded-control border-[1.5px] border-outline bg-media-surface transition-[border-color,box-shadow] duration-150 ease-app hover:border-outline-strong',
                      current && 'border-brand',
                      viewing && 'border-brand shadow-[0_0_0_3px_var(--hb-brand-glow)]',
                    )}
                    role="button"
                    tabIndex={0}
                    onClick={() => setPreviewVideoUrl(current ? '' : p)}
                    onKeyDown={(e) => e.key === 'Enter' && setPreviewVideoUrl(current ? '' : p)}
                  >
                    <video src={`/${p}`} poster={posterOf(`/${p}`) || undefined} preload="none" muted playsInline tabIndex={-1} className="block h-full w-full object-cover" />
                    <span className="absolute bottom-1 left-1 rounded-[3px] bg-black/60 px-1 py-px font-code text-[9px] text-white">{formatHistoryTime(taskCreatedAt(h))}</span>
                    {current ? (
                      <span className="absolute right-1 top-1 rounded-full bg-brand px-[5px] py-px text-[9px] font-bold text-on-action">{t('episode.vid.current')}</span>
                    ) : (
                      <button
                        type="button"
                        className="absolute right-[3px] top-[3px] hidden h-4 w-4 cursor-pointer items-center justify-center rounded-full border-0 bg-black/[0.62] text-[11px] leading-none text-white group-hover:flex"
                        title={t('episode.vid.deleteRecord')}
                        onClick={(e) => {
                          e.stopPropagation()
                          void removeHistoryVideo(h)
                        }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-[18px] pt-4 pb-[18px] max-860:overflow-visible">
          <section className="flex flex-col gap-[7px]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-bold text-content">{t('episode.inspector.boundRefs')}</span>
              <Badge mono>{boundRefAssets.length}</Badge>
            </div>
            {boundRefAssets.length > 0 ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-2">
                {boundRefAssets.map((asset) => {
                  const src = assetImageSrcOf(asset.imageUrl)
                  return (
                    <button
                      key={asset.key}
                      type="button"
                      className="relative aspect-square cursor-pointer overflow-hidden rounded-control border border-outline bg-elevated p-0 text-content-subtle transition-colors duration-150 hover:border-brand disabled:cursor-default disabled:hover:border-outline"
                      disabled={!asset.ready}
                      title={`${asset.name} · ${asset.typeLabel}`}
                      onClick={() => asset.ready && ui.openImage(src, `${asset.name} ${asset.typeLabel}`)}
                    >
                      {asset.ready ? (
                        <img
                          src={thumbOf(src)}
                          alt={asset.name}
                          loading="lazy"
                          className="block h-full w-full object-cover"
                          onError={(e) => thumbFallback(e, src)}
                        />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center text-[11px]">
                          {asset.kind === 'scene' ? t('episode.ref.shortScene') : asset.kind === 'prop' ? t('episode.ref.shortProp') : t('episode.ref.shortChar')}
                        </span>
                      )}
                      {/* 原 .video-bound-ref small 底部署名条 */}
                      <small className="absolute inset-x-0 bottom-0 overflow-hidden text-ellipsis whitespace-nowrap bg-black/[0.58] px-[5px] py-0.5 text-left text-[9.5px] text-white">
                        {asset.name}
                      </small>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="rounded-control border border-dashed border-outline p-2.5 text-[11px] leading-[1.5] text-content-subtle">{t('episode.inspector.noBoundRefs')}</div>
            )}
          </section>
        </div>

        {/* 分镜时长 + 生成操作常驻底部 */}
        <div className="flex flex-none flex-col gap-[7px] border-t border-outline bg-surface-muted px-3.5 pt-[9px] pb-[11px]">
          <section className="flex flex-col gap-[7px] rounded-panel border border-[color:var(--hb-brand-glow)] bg-brand-soft px-2.5 py-[7px]">
            <div className="flex items-center justify-between gap-2.5 whitespace-nowrap text-[12px]">
              <span className="shrink-0 font-semibold text-content-secondary">{t('episode.inspector.duration')}</span>
              <span className="inline-flex items-center gap-1.5">
                <Input
                  defaultValue={sb.duration || 10}
                  type="number"
                  min={2}
                  max={30}
                  key={sb.id}
                  className="h-6 w-14 px-1.5 py-0.5 text-center font-code text-[12px] font-bold"
                  onChange={(e) => wb.onVideoDurationChange(sb, e.target.value)}
                />
                <span className="text-[11px] text-content-muted">{t('episode.inspector.durationUnit')}</span>
              </span>
            </div>
            <div>{t('episode.inspector.durationHint')}</div>
          </section>
          <div className="m-0 overflow-hidden text-ellipsis whitespace-nowrap rounded-control border border-[color:var(--hb-brand-glow)] bg-brand-soft px-2 py-1 text-center font-code text-[10.5px] font-semibold leading-[1.4] text-brand-content">
            {t('episode.inspector.effective', {
              model: wb.effectiveVideoModelLabel || t('episode.vid.defaultModel'),
              res: resolutionShortOf(wb.resolutionProvider, wb.episodeResolution),
              dur: Number(sb.duration || 10),
            })}
          </div>
          <button
            type="button"
            className={cn(buttonVariants({ variant: 'primary' }), 'h-8 min-h-8 w-full px-3 text-[12.5px]')}
            disabled={state === 'pending'}
            onClick={() => void wb.genVid(sb)}
          >
            {actionLabel(t, state)}
          </button>
        </div>
      </aside>

      {/* 三栏分隔条（双击恢复默认） */}
      <div
        className="absolute inset-y-0 left-[calc(var(--vleft,236px)-4px)] z-[6] w-[9px] cursor-col-resize touch-none after:absolute after:inset-y-0 after:left-1 after:w-px after:bg-transparent after:content-[''] after:transition-[background-color,box-shadow] after:duration-150 hover:after:bg-brand hover:after:shadow-[0_0_6px_var(--hb-brand-glow)] active:after:bg-brand active:after:shadow-[0_0_6px_var(--hb-brand-glow)] max-860:hidden"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={(e) => startColDrag('left', e)}
        onDoubleClick={() => prefs.setVideoColumns({ left: VIDEO_COL_DEFAULTS.left, right: prefs.videoColumns.right })}
      />
      <div
        className="absolute inset-y-0 right-[calc(var(--vright,340px)-4px)] z-[6] w-[9px] cursor-col-resize touch-none after:absolute after:inset-y-0 after:left-1 after:w-px after:bg-transparent after:content-[''] after:transition-[background-color,box-shadow] after:duration-150 hover:after:bg-brand hover:after:shadow-[0_0_6px_var(--hb-brand-glow)] active:after:bg-brand active:after:shadow-[0_0_6px_var(--hb-brand-glow)] max-860:hidden"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={(e) => startColDrag('right', e)}
        onDoubleClick={() => prefs.setVideoColumns({ left: prefs.videoColumns.left, right: VIDEO_COL_DEFAULTS.right })}
      />
    </>
  )
}

function resolutionShortOf(provider: string, key: string): string {
  const display: Record<string, Record<string, string>> = {
    volcengine: { '480p': '480p', '720p': '720p', '1080p': '720p' },
    minimax: { '480p': '768P', '720p': '768P', '1080p': '2K' },
    aliyun: { '480p': '480P', '720p': '720P', '1080p': '1080P' },
  }
  return display[provider]?.[key] || key
}
