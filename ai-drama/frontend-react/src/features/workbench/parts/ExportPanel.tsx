/** 导出面板：成片列表（播放/下载）+ 镜头素材勾选拼接 + 手动标记完成 */
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { mapError } from '@/shared/lib/errors'
import { posterOf } from '@/shared/lib/media'
import { buttonVariants } from '@/shared/ui/button'
import { formatHistoryTime } from '../workbench-lib'
import { useWorkbench } from '../WorkbenchProvider'
import { useWorkbenchUi } from '../EpisodeWorkbenchPage'
import { useWorkbenchStore } from '../workbench-store'
import { cn } from '@/shared/lib/cn'

// 原 .dot（+ .ok）
const dotClass = 'h-[7px] w-[7px] shrink-0 rounded-full bg-sunken'

export function ExportPanel() {
  const wb = useWorkbench()
  const ui = useWorkbenchUi()
  const { t } = useTranslation()

  const exportSelectedIds = useWorkbenchStore((s) => s.exportSelectedIds)
  const setExportSelectedIds = useWorkbenchStore((s) => s.setExportSelectedIds)
  const exportSelTouched = useWorkbenchStore((s) => s.exportSelTouched)
  const markExportSelTouched = useWorkbenchStore((s) => s.markExportSelTouched)
  const setStage = useWorkbenchStore((s) => s.setStage)

  const readyIds = useMemo(() => wb.sbs.filter((s) => !!(s.videoUrl || s.composedVideoUrl)).map((s) => s.id), [wb.sbs])
  const selectedReadyIds = exportSelectedIds.filter((id) => readyIds.includes(id))
  const exportDone = wb.episode?.status === 'completed'

  // ready 集合变化：未手动操作过则自动全选；操作过则剔除失效勾选
  useEffect(() => {
    if (exportSelTouched) {
      setExportSelectedIds(exportSelectedIds.filter((id) => readyIds.includes(id)))
    } else {
      setExportSelectedIds([...readyIds])
    }

  }, [readyIds])

  const isExportSelected = (id: number) => exportSelectedIds.includes(id)
  const toggleExportSelect = (sb: { id: number; videoUrl: string; composedVideoUrl: string }) => {
    if (!(sb.videoUrl || sb.composedVideoUrl)) return
    markExportSelTouched()
    setExportSelectedIds(
      isExportSelected(sb.id) ? exportSelectedIds.filter((x) => x !== sb.id) : [...exportSelectedIds, sb.id],
    )
  }
  const toggleSelectAllExport = () => {
    markExportSelTouched()
    setExportSelectedIds(selectedReadyIds.length === readyIds.length ? [] : [...readyIds])
  }

  if (!wb.sbs.length) {
    return (
      <div className="relative flex flex-1 flex-col overflow-hidden min-h-0">
        <div className="flex flex-1 flex-col items-center justify-center gap-2.5 min-h-[300px] animate-fade-in p-[46px]">
          <div className="mb-2 flex h-[72px] w-[72px] items-center justify-center rounded-[22px] border border-outline bg-[var(--hb-bg-1)] text-brand shadow-raise">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </div>
          <div className="text-[22px] font-bold font-display text-content">{t('episode.prod.notReady')}</div>
          <div className="max-w-[420px] text-center text-[13px] leading-[1.8] text-content-muted">{t('episode.export.notReadyDesc')}</div>
          <button type="button" className={buttonVariants({ variant: 'primary' })} onClick={() => setStage('script')}>
            {t('episode.export.gotoScript')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden min-h-0">
      <div className="flex flex-1 min-h-0 max-1080:flex-col">
        <div className="flex flex-1 flex-col items-stretch gap-[18px] min-h-0 overflow-y-auto px-5 pt-4 pb-6">
          {/* 上方：成片列表 */}
          <div className="flex flex-col min-h-0">
            <div className="mb-2.5 flex items-center gap-2">
              <span className="text-[13px] font-extrabold text-content">{t('episode.export.filmList')}</span>
              <span className="text-content-subtle" style={{ fontSize: 11 }}>{t('episode.export.countN', { n: wb.exportMerges.length })}</span>
              <button
                type="button"
                className={cn(buttonVariants({ size: 'sm' }), 'ml-auto', exportDone && 'border-transparent bg-success-soft font-semibold text-success')}
                title={t('episode.export.markDoneTitle')}
                onClick={() => void wb.toggleExportDone()}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                {exportDone ? t('episode.export.markedDone') : t('episode.export.markDone')}
              </button>
              <button type="button" className={buttonVariants({ size: 'sm' })} onClick={wb.refreshExportMerges}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
                {t('common.refresh')}
              </button>
            </div>
            {wb.exportMerges.length > 0 ? (
              <div className="flex gap-3 overflow-x-auto pb-1">
                {wb.exportMerges.map((m) => {
                  const playable = m.status === 'completed' && !!m.mergedUrl
                  return (
                    <div
                      key={m.id}
                      className={cn(
                        'flex w-[260px] shrink-0 grow-0 basis-auto flex-col gap-1.5 rounded-control border border-outline bg-surface p-2',
                        playable && 'group cursor-pointer hover:border-outline-strong hover:shadow-card',
                      )}
                      role={playable ? 'button' : undefined}
                      tabIndex={playable ? 0 : undefined}
                      onClick={() => playable && ui.setActiveMerge(m)}
                      onKeyDown={(e) => e.key === 'Enter' && playable && ui.setActiveMerge(m)}
                    >
                      <div className="relative">
                        {playable ? (
                          <video src={`/${m.mergedUrl}`} poster={posterOf(`/${m.mergedUrl}`) || undefined} preload="none" muted playsInline tabIndex={-1} className="block aspect-video w-full rounded-md bg-media-surface" />
                        ) : (
                          <div
                            className={cn(
                              'flex aspect-video w-full items-center justify-center rounded-md px-3 text-center text-[11px]',
                              m.status === 'failed' ? 'bg-danger-soft text-danger' : 'bg-surface-muted text-content-subtle',
                            )}
                            title={m.status === 'failed' ? m.errorMsg : undefined}
                          >
                            {m.status === 'failed'
                              ? mapError(m.errorMsg, { fallback: 'episode.export.mergeFailed' })
                              : t('episode.export.merging')}
                          </div>
                        )}
                        {/* 悬停浮现的播放遮罩（原 .merge-card-play） */}
                        {playable && (
                          <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-black/[0.28] text-white opacity-0 transition-opacity duration-150 ease-app group-hover:opacity-100">
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3" /></svg>
                          </span>
                        )}
                      </div>
                      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-content-subtle">
                        <span className="font-code">{formatHistoryTime(m.createdAt)}</span>
                        {!!m.duration && <span>· {m.duration}s</span>}
                        {playable && (
                          <a href={`/${m.mergedUrl}`} download className={cn(buttonVariants({ size: 'sm' }), 'ml-auto')} onClick={(e) => e.stopPropagation()}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                            </svg>
                            {t('common.download')}
                          </a>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="rounded-control border border-dashed border-outline p-3.5 text-center text-[12px] text-content-subtle">{t('episode.export.empty')}</div>
            )}
          </div>

          {/* 下方：镜头素材（可勾选） */}
          <div className="flex flex-1 flex-col min-h-0">
            <div className="mb-2.5 flex items-center gap-2">
              <span className="text-[13px] font-extrabold text-content">{t('episode.export.shotAssets')}</span>
              <span className="text-content-subtle" style={{ fontSize: 11 }}>
                {t('episode.export.shotStat', {
                  done: wb.sbs.filter((s) => !!(s.videoUrl || s.composedVideoUrl)).length,
                  total: wb.sbs.length,
                  selected: selectedReadyIds.length,
                })}
              </span>
              <div className="ml-auto flex gap-1">
                <button type="button" className={buttonVariants({ size: 'sm' })} disabled={!readyIds.length} onClick={toggleSelectAllExport}>
                  {selectedReadyIds.length === readyIds.length && readyIds.length
                    ? t('episode.export.clearSelection')
                    : t('episode.export.selectAllReady')}
                </button>
                <button
                  type="button"
                  className={buttonVariants({ variant: 'primary', size: 'sm' })}
                  disabled={!selectedReadyIds.length}
                  onClick={() => void wb.doMerge(selectedReadyIds)}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                    <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
                  </svg>
                  {t('episode.export.mergeSelected', { n: selectedReadyIds.length })}
                </button>
              </div>
            </div>
            <div className="grid flex-1 grid-cols-[repeat(auto-fill,minmax(200px,1fr))] content-start gap-3 min-h-0 overflow-y-auto">
              {wb.sbs.map((sb, i) => {
                const vid = sb.videoUrl || sb.composedVideoUrl
                const playable = !!vid
                return (
                  <div
                    key={sb.id}
                    className={cn(
                      'group flex flex-col items-stretch gap-1.5 rounded-control border border-outline bg-surface p-2 transition-[border-color,box-shadow] duration-150 ease-app hover:border-outline-strong hover:shadow-card',
                      playable && 'cursor-pointer',
                      isExportSelected(sb.id) && 'border-brand shadow-[0_0_0_2px_var(--hb-brand-glow)]',
                    )}
                    role={playable ? 'button' : undefined}
                    tabIndex={playable ? 0 : undefined}
                    onClick={() => toggleExportSelect(sb)}
                    onKeyDown={(e) => e.key === 'Enter' && toggleExportSelect(sb)}
                  >
                    <div className="relative aspect-video w-full overflow-hidden rounded-md border border-outline bg-media-surface">
                      {playable ? (
                        <video src={`/${vid}`} poster={posterOf(`/${vid}`) || undefined} preload="none" muted playsInline tabIndex={-1} className="block h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-content-subtle">
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                            <polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                          </svg>
                        </div>
                      )}
                      <span className="absolute left-[5px] top-[5px] rounded-[4px] bg-black/[0.56] px-[5px] py-px font-code text-[10px] font-extrabold text-white">#{String(i + 1).padStart(2, '0')}</span>
                      {!!sb.duration && <span className="absolute bottom-[5px] right-[5px] rounded-[3px] bg-black/60 px-1 py-px font-code text-[9px] text-white">{sb.duration}s</span>}
                      {/* 镜头预览：悬停浮现的居中播放钮（原 .exp-play） */}
                      {playable && (
                        <span
                          className="absolute left-1/2 top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 scale-90 cursor-pointer items-center justify-center rounded-full bg-black/[0.62] text-white opacity-0 transition-[opacity,transform,background-color] duration-150 hover:bg-brand group-hover:scale-100 group-hover:opacity-100"
                          title={t('episode.export.previewShot')}
                          onClick={(e) => {
                            e.stopPropagation()
                            ui.setPreviewShot(sb)
                          }}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3" /></svg>
                        </span>
                      )}
                      {playable && (
                        <span
                          className={cn(
                            'absolute right-1.5 top-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full border-[1.5px] border-white/90 bg-black/[0.35] text-white',
                            isExportSelected(sb.id) && 'border-brand bg-brand',
                          )}
                        >
                          {isExportSelected(sb.id) && (
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </span>
                      )}
                    </div>
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate" style={{ flex: 1, fontSize: 11 }}>{sb.description || sb.title || '—'}</span>
                      <span className={cn(dotClass, playable && 'bg-success')} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
