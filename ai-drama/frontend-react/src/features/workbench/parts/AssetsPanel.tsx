/** 资产面板：角色/场景/道具三分栏卡片、提取任务、批量生图、上传、新增入口 */
import { useTranslation } from 'react-i18next'
import { Loader2, Plus, X } from 'lucide-react'
import { thumbOf, thumbFallback } from '@/shared/lib/media'
import { t as globalT2 } from '@/shared/config/i18n'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { cardVariants } from '@/shared/ui/card'
import { assetImageSrcOf } from '../workbench-lib'
import { useWorkbench } from '../WorkbenchProvider'
import { useWorkbenchUi } from '../EpisodeWorkbenchPage'
import { cn } from '@/shared/lib/cn'

const EXTRACT_TARGETS: { key: 'characters' | 'scenes' | 'props' }[] = [
  { key: 'characters' },
  { key: 'scenes' },
  { key: 'props' },
]

// 原 .asset-card/.asset-click-card/.character-asset-card 模块覆盖（card 之上）
const assetCardClass =
  'group relative flex flex-col overflow-hidden transition-[transform,box-shadow,border-color] duration-150 ease-app hover:-translate-y-0.5 hover:shadow-raised focus-visible:border-[color:var(--hb-brand-glow)] focus-visible:shadow-[0_0_0_3px_var(--hb-focus-ring),var(--hb-shadow-panel)] focus-visible:outline-none'
const characterAssetCardClass = cn(assetCardClass, 'min-h-0 cursor-pointer hover:border-outline-strong')
const assetClickCardClass = cn(assetCardClass, 'cursor-pointer')
// 原 .asset-del-btn（悬停卡片时浮现的删除按钮）
const assetDelBtnClass =
  'absolute right-2 top-2 z-[3] flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-full border-none bg-black/50 text-white opacity-0 transition-[opacity,background-color] duration-150 group-hover:opacity-100 hover:bg-[color:var(--hb-action-danger)]'
// 原 .asset-cover-badge（+ .is-ready/.is-pending）
const coverBadgeClass =
  'absolute left-[7px] top-[7px] inline-flex items-center rounded-full px-[7px] py-0.5 text-[9.5px] font-bold shadow-[0_1px_4px_rgba(0,0,0,0.08)] backdrop-blur-[10px]'
const coverBadgeState = {
  ready: 'bg-success-soft text-tag-success',
  pending: 'bg-brand-soft text-brand-content',
  todo: 'bg-white/85 text-content-muted',
}
// 原 .dot（+ .ok/.pending）
const dotClass = 'h-[7px] w-[7px] shrink-0 rounded-full bg-sunken'

export function AssetsPanel() {
  const wb = useWorkbench()
  const ui = useWorkbenchUi()
  const { t } = useTranslation()

  const charImgCount = wb.visualChars.filter((c) => c.imageUrl).length
  const sceneImgCount = wb.scenes.filter((s) => s.imageUrl).length
  const propImgCount = wb.props.filter((p) => p.imageUrl).length
  const assetTotalCount = wb.visualChars.length + wb.scenes.length + wb.props.length
  const assetReadyCount = charImgCount + sceneImgCount + propImgCount

  const extractLabelOf = (key: string) =>
    globalT2(key === 'characters' ? 'common.role' : key === 'scenes' ? 'common.scene' : 'common.prop')
  const countOf = (key: string) =>
    key === 'characters' ? wb.chars.length : key === 'scenes' ? wb.scenes.length : wb.props.length

  return (
    <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-3 pt-2.5 pb-3">
      <div className="flex items-center gap-[7px] flex-wrap">
        <span className="text-content-subtle" style={{ fontSize: 12 }}>{t('episode.prod.assets')}</span>
        <Badge mono>{t('episode.prod.readyCount', { ready: assetReadyCount, total: assetTotalCount })}</Badge>
        <div className="ml-auto flex items-center gap-1">
          {EXTRACT_TARGETS.map((et) => (
            <button
              key={et.key}
              type="button"
              className={cn(buttonVariants({ size: 'sm' }), 'border border-dashed border-outline-strong bg-transparent text-content-muted shadow-none hover:bg-surface-muted hover:text-content-secondary')}
              disabled={wb.isExtracting(et.key)}
              onClick={() => wb.doExtract(et.key)}
            >
              {wb.isExtracting(et.key) ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              )}
              {countOf(et.key)
                ? t('episode.prod.reextract', { type: extractLabelOf(et.key) })
                : t('episode.prod.extract', { type: extractLabelOf(et.key) })}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-outline-strong" />
          <button type="button" className={cn(buttonVariants({ size: 'sm' }), 'bg-brand-soft text-brand-content shadow-none hover:bg-brand hover:text-on-action')} onClick={() => wb.batchAssetImages('character')}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
            </svg>
            {t('episode.prod.batchChar')}
          </button>
          <button type="button" className={cn(buttonVariants({ size: 'sm' }), 'bg-brand-soft text-brand-content shadow-none hover:bg-brand hover:text-on-action')} onClick={() => wb.batchAssetImages('scene')}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
            </svg>
            {t('episode.prod.batchScene')}
          </button>
          <button type="button" className={cn(buttonVariants({ size: 'sm' }), 'bg-brand-soft text-brand-content shadow-none hover:bg-brand hover:text-on-action')} onClick={() => wb.batchAssetImages('prop')}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
            </svg>
            {t('episode.prod.batchProp')}
          </button>
        </div>
      </div>

      {wb.extractingTargets.length > 0 && !wb.chars.length && !wb.scenes.length && !wb.props.length ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <Loader2 size={24} className="animate-spin" style={{ color: 'var(--hb-brand)' }} />
          <div className="text-[13px] text-content-muted">{t('episode.prod.extractingTypes', { types: wb.extractingLabel })}</div>
        </div>
      ) : !wb.chars.length && !wb.scenes.length && !wb.props.length ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2.5 min-h-[300px] animate-fade-in p-[46px]">
          <div className="mb-2 flex h-[72px] w-[72px] items-center justify-center rounded-[22px] border border-outline bg-[var(--hb-bg-1)] text-brand shadow-raise">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </div>
          <div className="text-[22px] font-bold font-display text-content">{t('episode.prod.emptyTitle')}</div>
          <div className="max-w-[420px] text-center text-[13px] leading-[1.8] text-content-muted">{t('episode.prod.emptyDesc')}</div>
          <button
            type="button"
            className={buttonVariants({ variant: 'primary' })}
            disabled={!!wb.extractingTargets.length}
            onClick={wb.doExtractAll}
          >
            {wb.extractingTargets.length ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            )}
            {wb.extractingTargets.length
              ? t('episode.prod.extractingTypesDots', { types: wb.extractingLabel })
              : t('episode.prod.startExtract')}
          </button>
        </div>
      ) : (
        <>
          {/* 角色 */}
          <div className="mt-0.5 flex items-center gap-2 text-[12px] font-extrabold tracking-[0.04em] text-content-secondary">
            {t('common.role')}
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-[3px] rounded-full border border-dashed border-outline-strong bg-transparent px-2 py-0.5 text-[11px] font-semibold transition-colors duration-150 hover:border-brand-content hover:text-brand-content"
              onClick={() => ui.openAssetCreate('character')}
            >
              <Plus size={11} /> {t('common.add')}
            </button>
          </div>
          {wb.visualChars.length > 0 && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,260px))] justify-start gap-2.5 max-1080:grid-cols-[repeat(auto-fill,minmax(420px,1fr))] max-1080:max-860:grid-cols-1">
              {wb.visualChars.map((c) => {
                const src = assetImageSrcOf(c.imageUrl)
                const pending = wb.pendingCharImageIds.includes(c.id)
                return (
                  <article
                    key={c.id}
                    className={cn(cardVariants(), characterAssetCardClass)}
                    tabIndex={0}
                    role="button"
                    onClick={() => ui.openAssetDetail('character', c.id)}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), ui.openAssetDetail('character', c.id))}
                  >
                    <button
                      type="button"
                      className={assetDelBtnClass}
                      title={t('episode.asset.delChar')}
                      onClick={(e) => {
                        e.stopPropagation()
                        ui.askDeleteAsset('character', c.id, c.name)
                      }}
                    >
                      <X size={11} />
                    </button>
                    <div className="flex w-full min-w-0 flex-col gap-2 p-2 max-860:p-2.5">
                      <div className="flex flex-col gap-2">
                        <div className="relative aspect-video w-full self-start overflow-hidden rounded-control border border-outline bg-elevated max-860:w-auto">
                          {src && (
                            <img
                              src={thumbOf(src)}
                              className="previewable-image h-full w-full object-cover"
                              loading="lazy"
                              onError={(e) => thumbFallback(e, src)}
                              onClick={(e) => {
                                e.stopPropagation()
                                ui.openImage(src, t('episode.asset.charImageTitle', { name: c.name }))
                              }}
                            />
                          )}
                          {!src && (
                            <div className="flex h-full w-full items-center justify-center text-content-subtle">
                              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                              </svg>
                            </div>
                          )}
                          <span className={cn(coverBadgeClass, src ? coverBadgeState.ready : pending ? coverBadgeState.pending : coverBadgeState.todo)}>
                            {src ? t('episode.asset.portraitReady') : pending ? t('episode.asset.portraitPending') : t('episode.asset.portraitTodo')}
                          </span>
                        </div>
                        <div className="flex min-w-0 items-center justify-between gap-2 max-860:flex-col max-860:items-stretch">
                          <div className="flex min-w-0 flex-col gap-1">
                            <div className="flex min-w-0 items-center gap-[5px] flex-wrap">
                              <strong className="text-[13px] leading-[1.25] text-content">{c.name}</strong>
                              <Badge>{c.role || t('common.role')}</Badge>
                            </div>
                            <div
                              className="flex max-w-full gap-2 overflow-hidden text-[10.5px] leading-[1.45] whitespace-nowrap text-content-subtle"
                              title={`${t('episode.asset.appearance')}${c.appearance || t('episode.asset.appearanceTodo')} · ${t('episode.asset.styling')}${c.styling || t('episode.asset.stylingTodo')}`}
                            >
                              <span className="min-w-0 overflow-hidden text-ellipsis">{t('episode.asset.appearance')}{c.appearance || t('episode.asset.appearanceTodo')}</span>
                              <span className="min-w-0 overflow-hidden text-ellipsis">{t('episode.asset.styling')}{c.styling || t('episode.asset.stylingTodo')}</span>
                            </div>
                          </div>
                          <button
                            type="button"
                            className={cn(buttonVariants({ size: 'sm' }), 'shrink-0 self-center')}
                            disabled={pending}
                            onClick={(e) => {
                              e.stopPropagation()
                              void wb.genAssetImage('character', c.id)
                            }}
                          >
                            {pending && <Loader2 size={11} className="animate-spin" />}
                            {src ? t('episode.asset.regen') : pending ? t('episode.asset.generating') : t('episode.asset.generate')}
                          </button>
                          <button
                            type="button"
                            className={buttonVariants({ size: 'sm' })}
                            title={t('episode.asset.uploadCharImage')}
                            disabled={wb.isUploadingAsset('character', c.id)}
                            onClick={(e) => {
                              e.stopPropagation()
                              wb.uploadAssetImage('character', c.id)
                            }}
                          >
                            {wb.isUploadingAsset('character', c.id) ? (
                              <Loader2 size={11} className="animate-spin" />
                            ) : (
                              <UploadIcon />
                            )}
                            {t('episode.asset.upload')}
                          </button>
                        </div>
                      </div>
                      <div className="flex flex-col gap-0.5 border-t border-outline pt-[7px] text-[10.5px] leading-[1.5]" title={c.finalPrompt}>
                        <span className="text-[9.5px] font-bold tracking-[0.05em] text-content-subtle">{t('episode.asset.finalPromptTurnaround')}</span>
                        <span className={cn('line-clamp-2 overflow-hidden break-words text-content-muted', !c.finalPrompt && 'text-content-subtle')}>
                          {c.finalPrompt || t('episode.asset.finalPromptAutoTurnaround')}
                        </span>
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          )}

          {/* 场景 */}
          <div className="mt-0.5 flex items-center gap-2 text-[12px] font-extrabold tracking-[0.04em] text-content-secondary">
            {t('common.scene')}
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-[3px] rounded-full border border-dashed border-outline-strong bg-transparent px-2 py-0.5 text-[11px] font-semibold transition-colors duration-150 hover:border-brand-content hover:text-brand-content"
              onClick={() => ui.openAssetCreate('scene')}
            >
              <Plus size={11} /> {t('common.add')}
            </button>
          </div>
          {wb.scenes.length > 0 && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] items-stretch gap-3 max-860:grid-cols-1">
              {wb.scenes.map((s) => {
                const src = assetImageSrcOf(s.imageUrl)
                const pending = wb.pendingSceneImageIds.includes(s.id)
                return (
                  <div
                    key={s.id}
                    className={cn(cardVariants(), assetClickCardClass)}
                    tabIndex={0}
                    role="button"
                    onClick={() => ui.openAssetDetail('scene', s.id)}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), ui.openAssetDetail('scene', s.id))}
                  >
                    <button
                      type="button"
                      className={assetDelBtnClass}
                      title={t('episode.asset.delScene')}
                      onClick={(e) => {
                        e.stopPropagation()
                        ui.askDeleteAsset('scene', s.id, s.location)
                      }}
                    >
                      <X size={11} />
                    </button>
                    <div className="relative aspect-video overflow-hidden bg-elevated">
                      {src && (
                        <img
                          src={thumbOf(src)}
                          className="previewable-image h-full w-full object-cover"
                          loading="lazy"
                          onError={(e) => thumbFallback(e, src)}
                          onClick={(e) => {
                            e.stopPropagation()
                            ui.openImage(src, t('episode.asset.sceneImageTitle', { name: s.location }))
                          }}
                        />
                      )}
                      {!src && (
                        <div className="flex h-full w-full items-center justify-center text-content-subtle">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" />
                          </svg>
                        </div>
                      )}
                      <span className={cn(coverBadgeClass, src ? coverBadgeState.ready : pending ? coverBadgeState.pending : coverBadgeState.todo)}>
                        {src ? t('episode.asset.ready') : pending ? t('episode.asset.generating') : t('episode.asset.todo')}
                      </span>
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-[3px] pb-2 pl-[11px] pr-[11px] pt-[9px]">
                      <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-[650] text-content" title={s.location}>{s.location}</div>
                      <div className="line-clamp-2 overflow-hidden break-words text-[11px] leading-[1.5] text-content-subtle" title={s.prompt || t('episode.asset.sceneDescTodo')}>
                        {s.prompt || t('episode.asset.sceneDescTodo')}
                      </div>
                      {!!s.lighting && (
                        <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[11px] leading-[1.5] text-content-subtle" title={s.lighting}>
                          {t('episode.asset.lighting')}{s.lighting}
                        </div>
                      )}
                      <div className={cn('line-clamp-2 overflow-hidden break-words text-[11px] leading-[1.5]', !s.finalPrompt ? 'text-content-subtle' : 'text-content-muted')} title={s.finalPrompt}>
                        <span className="mr-1 text-[9.5px] font-bold tracking-[0.05em] text-content-subtle">{t('episode.asset.finalPromptFixed')}</span>
                        {s.finalPrompt || t('episode.asset.finalPromptAutoFixed')}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 border-t border-outline py-[7px] pl-[11px] pr-[11px]">
                      <span className={cn(dotClass, src ? 'bg-success' : pending ? 'bg-brand shadow-[0_0_0_3px_var(--hb-brand-glow)]' : '')} />
                      <button
                        type="button"
                        className={cn(buttonVariants({ size: 'sm' }), 'ml-auto')}
                        title={t('episode.asset.uploadSceneImage')}
                        disabled={wb.isUploadingAsset('scene', s.id)}
                        onClick={(e) => {
                          e.stopPropagation()
                          wb.uploadAssetImage('scene', s.id)
                        }}
                      >
                        {wb.isUploadingAsset('scene', s.id) ? <Loader2 size={11} className="animate-spin" /> : <UploadIcon />}
                        {t('episode.asset.upload')}
                      </button>
                      <button
                        type="button"
                        className={buttonVariants({ size: 'sm' })}
                        disabled={pending}
                        onClick={(e) => {
                          e.stopPropagation()
                          void wb.genAssetImage('scene', s.id)
                        }}
                      >
                        {pending && <Loader2 size={11} className="animate-spin" />}
                        {src ? t('episode.asset.regen') : pending ? t('episode.asset.generating') : t('episode.asset.generate')}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* 道具 */}
          <div className="mt-0.5 flex items-center gap-2 text-[12px] font-extrabold tracking-[0.04em] text-content-secondary">
            {t('common.prop')}
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-[3px] rounded-full border border-dashed border-outline-strong bg-transparent px-2 py-0.5 text-[11px] font-semibold transition-colors duration-150 hover:border-brand-content hover:text-brand-content"
              onClick={() => ui.openAssetCreate('prop')}
            >
              <Plus size={11} /> {t('common.add')}
            </button>
          </div>
          {wb.props.length > 0 ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] items-stretch gap-3 max-860:grid-cols-1">
              {wb.props.map((p) => {
                const src = assetImageSrcOf(p.imageUrl)
                const pending = wb.pendingPropImageIds.includes(p.id)
                return (
                  <div
                    key={p.id}
                    className={cn(cardVariants(), assetClickCardClass)}
                    tabIndex={0}
                    role="button"
                    onClick={() => ui.openAssetDetail('prop', p.id)}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), ui.openAssetDetail('prop', p.id))}
                  >
                    <button
                      type="button"
                      className={assetDelBtnClass}
                      title={t('episode.asset.delProp')}
                      onClick={(e) => {
                        e.stopPropagation()
                        ui.askDeleteAsset('prop', p.id, p.name)
                      }}
                    >
                      <X size={11} />
                    </button>
                    <div className="relative aspect-video overflow-hidden bg-elevated">
                      {src && (
                        <img
                          src={thumbOf(src)}
                          className="previewable-image h-full w-full object-cover"
                          loading="lazy"
                          onError={(e) => thumbFallback(e, src)}
                          onClick={(e) => {
                            e.stopPropagation()
                            ui.openImage(src, t('episode.asset.propImageTitle', { name: p.name }))
                          }}
                        />
                      )}
                      {!src && (
                        <div className="flex h-full w-full items-center justify-center text-content-subtle">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                            <polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" />
                          </svg>
                        </div>
                      )}
                      <span className={cn(coverBadgeClass, src ? coverBadgeState.ready : pending ? coverBadgeState.pending : coverBadgeState.todo)}>
                        {src ? t('episode.asset.ready') : pending ? t('episode.asset.generating') : t('episode.asset.todo')}
                      </span>
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-[3px] pb-2 pl-[11px] pr-[11px] pt-[9px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-[650] text-content" title={p.name}>{p.name}</span>
                        <Badge>{p.type || t('common.prop')}</Badge>
                      </div>
                      <div className="line-clamp-2 overflow-hidden break-words text-[11px] leading-[1.5] text-content-subtle" title={p.description ?? ''}>
                        {p.description || t('episode.asset.noDescription')}
                      </div>
                      <div className={cn('line-clamp-2 overflow-hidden break-words text-[11px] leading-[1.5]', !p.finalPrompt ? 'text-content-subtle' : 'text-content-muted')} title={p.finalPrompt}>
                        <span className="mr-1 text-[9.5px] font-bold tracking-[0.05em] text-content-subtle">{t('episode.asset.finalPromptWhiteBg')}</span>
                        {p.finalPrompt || t('episode.asset.finalPromptAutoWhiteBg')}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 border-t border-outline py-[7px] pl-[11px] pr-[11px]">
                      <span className={cn(dotClass, src ? 'bg-success' : pending ? 'bg-brand shadow-[0_0_0_3px_var(--hb-brand-glow)]' : '')} />
                      <button
                        type="button"
                        className={cn(buttonVariants({ size: 'sm' }), 'ml-auto')}
                        title={t('episode.asset.uploadPropImage')}
                        disabled={wb.isUploadingAsset('prop', p.id)}
                        onClick={(e) => {
                          e.stopPropagation()
                          wb.uploadAssetImage('prop', p.id)
                        }}
                      >
                        {wb.isUploadingAsset('prop', p.id) ? <Loader2 size={11} className="animate-spin" /> : <UploadIcon />}
                        {t('episode.asset.upload')}
                      </button>
                      <button
                        type="button"
                        className={buttonVariants({ size: 'sm' })}
                        disabled={pending}
                        onClick={(e) => {
                          e.stopPropagation()
                          void wb.genAssetImage('prop', p.id)
                        }}
                      >
                        {pending && <Loader2 size={11} className="animate-spin" />}
                        {src ? t('episode.asset.regen') : pending ? t('episode.asset.generating') : t('episode.asset.generate')}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="rounded-control border border-dashed border-outline p-3.5 text-center text-[12px] text-content-subtle">{t('episode.asset.propsEmpty')}</div>
          )}
        </>
      )}
    </div>
  )
}

function UploadIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  )
}
