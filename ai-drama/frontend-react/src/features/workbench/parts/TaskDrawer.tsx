/**
 * 任务抽屉：image/video/merge 统一时间线；数据来自聚合 jobs 查询（抽屉只是消费者）。
 * 样式已迁移 Tailwind。局部例外：`taskDrawerIn` 关键帧随本组件内联 <style> 输出
 * （原 CSS Modules 删除后无全局宿主），仅服务抽屉滑入动画。
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, ListTodo, X } from 'lucide-react'
import { mapError } from '@/shared/lib/errors'
import { posterOf, thumbOf, thumbFallback } from '@/shared/lib/media'
import { mediaSrcOf } from '../workbench-lib'
import { useWorkbench } from '../WorkbenchProvider'
import { useWorkbenchUi } from '../EpisodeWorkbenchPage'
import { useWorkbenchStore } from '../workbench-store'
import { buttonVariants } from '@/shared/ui/button'
import { cn } from '@/shared/lib/cn'

/* 原 @keyframes taskDrawerIn（局部例外，见文件头注释） */
const DRAWER_KEYFRAMES =
  '@keyframes taskDrawerIn{from{transform:translateX(24px);opacity:0}to{transform:translateX(0);opacity:1}}'

// 原 .video-task-metric/.video-task-status 徽章基样式（+ .is-done/.is-pending/.is-failed 状态）
const metricClass =
  'inline-flex items-center gap-[5px] min-h-[22px] rounded-full border border-outline bg-track px-2 text-[11px] font-[750] whitespace-nowrap text-content-muted'
const metricStateClass: Record<string, string> = {
  done: 'border-success-soft bg-success-soft text-success',
  pending: 'border-[color:var(--hb-brand-glow)] bg-brand-soft text-brand-content',
  failed: 'border-warning-soft bg-warning-soft text-warning',
}
// 行级背景（原 .video-task-row.is-pending / .is-failed；is-done 无行级样式）
const rowStateClass: Record<string, string> = {
  completed: '',
  failed: 'bg-danger-soft',
  pending: 'bg-hover-overlay',
}

export function TaskDrawer() {
  const wb = useWorkbench()
  const ui = useWorkbenchUi()
  const { t } = useTranslation()
  const open = useWorkbenchStore((s) => s.taskDrawerOpen)
  const setTaskDrawerOpen = useWorkbenchStore((s) => s.setTaskDrawerOpen)

  const rows = useMemo(() => {
    const taskRows = wb.jobs.tasks.map((x) => ({
      key: `task-${x.id}`,
      kind: x.type as string,
      id: x.id,
      targetLabel: targetLabel(wb, x, t),
      provider: x.provider || '',
      model: x.model || '',
      status: x.status || 'processing',
      errorMsg: x.errorMsg || '',
      previewUrl: x.localPath || x.resultUrl || '',
      createdAt: x.createdAt || '',
      completedAt: x.completedAt || '',
    }))
    const mergeRows = wb.jobs.merges.map((m) => ({
      key: `merge-${m.id}`,
      kind: 'merge',
      id: m.id,
      targetLabel: t('episode.tasks.fullMerge'),
      provider: m.provider || 'ffmpeg',
      model: m.model || '',
      status: m.status || 'pending',
      errorMsg: m.errorMsg || '',
      previewUrl: m.mergedUrl || '',
      createdAt: m.createdAt || '',
      completedAt: m.completedAt || '',
    }))
    return [...taskRows, ...mergeRows].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  }, [wb.jobs, wb, t])

  if (!open) return null

  const activeCount =
    wb.jobs.tasks.filter((x) => x.status === 'processing').length +
    wb.jobs.merges.filter((m) => m.status === 'processing' || m.status === 'pending').length
  const doneCount =
    wb.jobs.tasks.filter((x) => x.status === 'completed').length +
    wb.jobs.merges.filter((m) => m.status === 'completed').length
  const failedCount =
    wb.jobs.tasks.filter((x) => x.status === 'failed').length + wb.jobs.merges.filter((m) => m.status === 'failed').length

  return (
    <div
      className="fixed inset-0 z-[118] flex justify-end bg-scrim backdrop-blur-[8px] animate-[fadeIn_0.18s_var(--hb-ease-out)]"
      onClick={(e) => e.target === e.currentTarget && setTaskDrawerOpen(false)}
    >
      <style>{DRAWER_KEYFRAMES}</style>
      <aside
        className="flex h-full w-[min(560px,100vw)] flex-col border-l border-outline bg-surface shadow-dialog animate-[taskDrawerIn_0.22s_var(--hb-ease-out)]"
        role="dialog"
        aria-modal="true"
        aria-label={t('episode.tasks.title')}
      >
        <header className="flex items-center justify-between gap-3 border-b border-outline py-3.5 px-4">
          <div>
            <div className="text-[13px] leading-[1.2] font-[850] text-content">{t('episode.tasks.title')}</div>
            <div className="mt-[3px] text-[11px] leading-[1.35] text-content-subtle">{t('episode.tasks.meta', { n: rows.length })}</div>
          </div>
          <div className="flex items-center gap-1.5">
            <button type="button" className={buttonVariants({ size: 'sm' })} onClick={() => void wb.refresh()}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
              {t('common.refresh')}
            </button>
            <button type="button" className={buttonVariants({ variant: 'ghost', size: 'icon' })} onClick={() => setTaskDrawerOpen(false)}>
              <X size={14} />
            </button>
          </div>
        </header>
        <div className="flex flex-wrap items-center justify-end gap-1.5 border-b border-outline px-4 py-2.5 max-1080:w-full max-1080:justify-start">
          <span className={cn(metricClass, metricStateClass.pending)}>{t('episode.vid.metricPending', { n: activeCount })}</span>
          <span className={cn(metricClass, metricStateClass.done)}>{t('episode.vid.metricDone', { n: doneCount })}</span>
          <span className={cn(metricClass, metricStateClass.failed)}>{t('episode.vid.metricFailed', { n: failedCount })}</span>
        </div>
        {!rows.length ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2.5 min-h-[300px] animate-[fadeIn_0.3s_var(--hb-ease-out)] p-[46px]">
            <div className="mb-2 flex h-[72px] w-[72px] items-center justify-center rounded-[22px] border border-outline bg-[var(--hb-bg-1)] text-brand shadow-raise">
              <ListTodo size={32} />
            </div>
            <div className="text-[22px] font-bold font-display text-content">{t('episode.tasks.emptyTitle')}</div>
            <div className="max-w-[420px] text-center text-[13px] leading-[1.8] text-content-muted">{t('episode.tasks.emptyDesc')}</div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col min-h-0 overflow-y-auto">
            {rows.map((row) => {
              const stateKey = row.status === 'completed' ? 'completed' : row.status === 'failed' ? 'failed' : 'pending'
              const src = mediaSrcOf(row.previewUrl)
              const kindLabel =
                row.kind === 'image' ? t('common.serviceType.image') : row.kind === 'video' ? t('common.serviceType.video') : t('episode.tasks.mergeKind')
              const duration =
                row.createdAt && row.completedAt
                  ? (() => {
                      const ms = new Date(row.completedAt).getTime() - new Date(row.createdAt).getTime()
                      if (!Number.isFinite(ms) || ms < 0) return ''
                      return ms >= 60000 ? `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s` : `${Math.round(ms / 1000)}s`
                    })()
                  : ''
              return (
                <div
                  key={row.key}
                  className={cn(
                    'grid grid-cols-[84px_minmax(0,1fr)_auto] cursor-default items-center gap-2 border-t border-outline px-2 py-1.5 transition-[background,border-color] duration-150 ease-app first:border-t-0 hover:bg-hover-overlay',
                    rowStateClass[stateKey],
                  )}
                >
                  <div className="relative aspect-video w-14 overflow-hidden rounded-item border border-outline bg-elevated">
                    {row.previewUrl && (row.kind === 'video' || row.kind === 'merge') ? (
                      <video
                        src={src}
                        poster={posterOf(src) || undefined}
                        controls
                        preload="none"
                        playsInline
                        className="block h-full w-full object-cover"
                      />
                    ) : row.previewUrl ? (
                      <img
                        src={thumbOf(src)}
                        alt={row.targetLabel}
                        loading="lazy"
                        className="h-full w-full cursor-zoom-in object-cover"
                        onError={(e) => thumbFallback(e, src)}
                        onClick={() => ui.openImage(src, row.targetLabel)}
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-content-subtle">
                        {row.status === 'processing' || row.status === 'pending' ? (
                          <Loader2 size={18} className="animate-spin" />
                        ) : (
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                            <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
                          </svg>
                        )}
                      </div>
                    )}
                    <span className="absolute left-[3px] top-[3px] rounded-[3px] bg-black/[0.56] px-1 font-code text-[9px] font-extrabold text-white">{kindLabel}</span>
                  </div>
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <strong className="min-w-0 truncate text-[12px] leading-[1.35] text-content">{row.targetLabel}</strong>
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-[5px] overflow-hidden whitespace-nowrap text-[10.5px] text-content-subtle">
                      <span className="truncate text-content-muted">
                        {row.provider}
                        {row.model ? ` · ${row.model}` : ''}
                      </span>
                      {duration && (
                        <>
                          <span className="text-content-subtle opacity-50">·</span>
                          <span>{t('episode.tasks.duration', { dur: duration })}</span>
                        </>
                      )}
                      <span className="text-content-subtle opacity-50">·</span>
                      <span>#{row.id}</span>
                    </div>
                    {row.errorMsg && (
                      <div className="mt-[5px] text-[11px] leading-[1.45] text-danger" title={row.errorMsg}>
                        {mapError(row.errorMsg)}
                        {row.kind === 'video' && wb.videoModerationHint(row.errorMsg) && (
                          <div className="mt-[3px] font-semibold text-brand-content">{wb.videoModerationHint(row.errorMsg)}</div>
                        )}
                      </div>
                    )}
                  </div>
                  <span className={cn('justify-self-end self-center', metricClass, metricStateClass[stateKey])}>
                    <span
                      className={cn(
                        'h-[7px] w-[7px] shrink-0 rounded-full bg-sunken',
                        row.status === 'completed' && 'bg-success',
                        (row.status === 'processing' || row.status === 'pending') && 'bg-brand shadow-[0_0_0_3px_var(--hb-brand-glow)]',
                      )}
                    />
                    {row.status === 'completed'
                      ? t('episode.status.done')
                      : row.status === 'failed'
                        ? t('episode.status.failed')
                        : t('episode.status.generating')}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </aside>
    </div>
  )
}

function targetLabel(
  wb: ReturnType<typeof useWorkbench>,
  x: { storyboardId: number | null; characterId: number | null; sceneId: number | null; propId: number | null },
  t: (k: string, params?: Record<string, unknown>) => string,
): string {
  if (x.storyboardId) {
    const sb = wb.sbs.find((y) => y.id === x.storyboardId)
    return t('episode.tasks.sbN', { n: sb?.storyboardNumber ?? x.storyboardId })
  }
  if (x.characterId) {
    const c = wb.chars.find((y) => y.id === x.characterId)
    return `${t('common.role')} · ${c?.name || x.characterId}`
  }
  if (x.sceneId) {
    const s = wb.scenes.find((y) => y.id === x.sceneId)
    return `${t('common.scene')} · ${s?.location || x.sceneId}`
  }
  if (x.propId) {
    const p = wb.props.find((y) => y.id === x.propId)
    return `${t('common.prop')} · ${p?.name || x.propId}`
  }
  return t('episode.tasks.generic')
}
