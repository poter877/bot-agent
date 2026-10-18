/**
 * 工作台路由入口：
 * 参数校验 → WorkbenchProvider（数据/动作）→ 顶栏/侧栏/主面板/任务抽屉/弹窗。
 * 预览弹窗（图片/镜头/成片）与资产弹窗为页面级状态，经 WorkbenchUiContext 分发。
 */
import { createContext, useContext, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { Storyboard } from '@/entities/storyboard/model'
import type { VideoMerge } from '@/entities/generation-task/model'
import type { AssetKind } from '@/entities/asset/model'
import { WorkbenchProvider, useWorkbench } from './WorkbenchProvider'
import { useWorkbenchStore } from './workbench-store'
import { WorkbenchTopbar } from './parts/Topbar'
import { WorkbenchSidebar } from './parts/Sidebar'
import { ScriptPanel } from './parts/ScriptPanel'
import { AssetsPanel } from './parts/AssetsPanel'
import { VideosPanel } from './parts/VideosPanel'
import { ExportPanel } from './parts/ExportPanel'
import { TaskDrawer } from './parts/TaskDrawer'
import { AssetDetailDialog, AssetCreateDialog } from './parts/AssetDialogs'
import { ImageViewer, VideoViewer } from './parts/viewers'
import { ConfirmDialog } from '@/shared/ui/ConfirmDialog'
import { buttonVariants } from '@/shared/ui/button'
import { startTour } from '@/shared/lib/tour'
import { cn } from '@/shared/lib/cn'
import { formatHistoryTime } from './workbench-lib'
import { t as globalT } from '@/shared/config/i18n'

// ===== 原 EpisodeWorkbenchPage.module.css → Tailwind（共享布局类） =====
// .studio：工作台整体骨架
const studioClass = 'flex h-screen flex-col gap-2 overflow-hidden bg-app p-2'
// .studio-body：侧栏列宽跟随实际宽度（收起 46px）
const studioBodyClass = 'grid flex-1 grid-cols-[auto_minmax(0,1fr)] gap-2 min-h-0 max-1080:grid-cols-1'
// .main
const mainClass = 'flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden rounded-control border border-outline bg-surface shadow-card'
// .content-panel
const contentPanelClass = 'relative flex min-h-0 flex-1 flex-col overflow-hidden'
// .step-empty（+ .empty-visual/.empty-title/.empty-desc）
const stepEmptyClass = 'flex min-h-[300px] flex-1 flex-col items-center justify-center gap-2.5 animate-fade-in p-[46px]'
const emptyVisualClass = 'mb-2 flex h-[72px] w-[72px] items-center justify-center rounded-[22px] border border-outline bg-[var(--hb-bg-1)] text-brand shadow-raise'
const emptyTitleClass = 'text-[22px] font-bold font-display text-content'
const emptyDescClass = 'max-w-[420px] text-center text-[13px] leading-[1.8] text-content-muted'

const EPISODE_TOUR = [
  { element: '.studio-topbar-main', titleKey: 'tour.episode.topbar.title', descKey: 'tour.episode.topbar.desc', popoverSide: 'bottom' },
  { element: '.pipe-section:nth-of-type(1)', titleKey: 'tour.episode.script.title', descKey: 'tour.episode.script.desc', popoverSide: 'right' },
  { element: '.pipe-section:nth-of-type(2)', titleKey: 'tour.episode.assets.title', descKey: 'tour.episode.assets.desc', popoverSide: 'right' },
  { element: '.pipe-section:nth-of-type(2) .pipe-item:last-child', titleKey: 'tour.episode.videos.title', descKey: 'tour.episode.videos.desc', popoverSide: 'right' },
  { element: '.studio-actions .tour-help-btn', titleKey: 'tour.episode.help.title', descKey: 'tour.episode.help.desc', popoverSide: 'bottom', popoverAlign: 'end' },
] as const

// ===== 预览与资产弹窗的页面级上下文 =====
interface WorkbenchUiContextValue {
  openImage: (src: string, title?: string) => void
  setPreviewShot: (sb: Storyboard | null) => void
  setActiveMerge: (m: VideoMerge | null) => void
  openAssetDetail: (kind: AssetKind, id: number) => void
  openAssetCreate: (kind: AssetKind) => void
  askDeleteAsset: (kind: AssetKind, id: number, name: string) => void
}

const WorkbenchUiContext = createContext<WorkbenchUiContextValue | null>(null)

export function useWorkbenchUi(): WorkbenchUiContextValue {
  const ctx = useContext(WorkbenchUiContext)
  if (!ctx) throw new Error('useWorkbenchUi must be used within EpisodeWorkbenchPage')
  return ctx
}

export function EpisodeWorkbenchPage() {
  const params = useParams()
  const dramaId = Number(params.id)
  const episodeNumber = Number(params.episodeNumber)

  if (!(Number.isInteger(dramaId) && dramaId > 0 && Number.isInteger(episodeNumber) && episodeNumber > 0)) {
    return <InvalidParams />
  }
  return (
    <WorkbenchProvider dramaId={dramaId} episodeNumber={episodeNumber}>
      <EpisodeWorkbenchShell />
    </WorkbenchProvider>
  )
}

function InvalidParams() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <div className={studioClass} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="text-content-subtle" style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p>{t('errors.unknown')}</p>
        <button type="button" className={buttonVariants({ variant: 'primary' })} onClick={() => navigate('/')}>
          {t('routeError.backHome')}
        </button>
      </div>
    </div>
  )
}

function EpisodeWorkbenchShell() {
  const wb = useWorkbench()
  const { t } = useTranslation()
  const navigate = useNavigate()

  // 预览弹窗
  const [image, setImage] = useState({ open: false, src: '', title: '' })
  const [previewShot, setPreviewShot] = useState<Storyboard | null>(null)
  const [activeMerge, setActiveMerge] = useState<VideoMerge | null>(null)

  // 资产弹窗
  const [assetDetail, setAssetDetail] = useState<{ kind: AssetKind; id: number } | null>(null)
  const [assetCreateKind, setAssetCreateKind] = useState<AssetKind | null>(null)
  const [assetDelete, setAssetDelete] = useState<{ kind: AssetKind; id: number; name: string } | null>(null)
  const [deleting, setDeleting] = useState(false)

  const ui = useMemo<WorkbenchUiContextValue>(
    () => ({
      openImage: (src, title = '') => {
        if (!src) return
        setImage({ open: true, src, title })
      },
      setPreviewShot,
      setActiveMerge,
      openAssetDetail: (kind, id) => setAssetDetail({ kind, id }),
      openAssetCreate: (kind) => setAssetCreateKind(kind),
      askDeleteAsset: (kind, id, name) => setAssetDelete({ kind, id, name }),
    }),
    [],
  )

  if (wb.dramaError) {
    return (
      <div className={studioClass} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="text-content-subtle">{wb.dramaError.message || t('errors.unknown')}</div>
      </div>
    )
  }
  if (!wb.ready || !wb.drama) {
    return (
      <div className={studioClass} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="text-content-subtle">{t('common.loading')}</div>
      </div>
    )
  }

  const previewShotSrc = previewShot ? previewShot.videoUrl || previewShot.composedVideoUrl : ''

  return (
    <WorkbenchUiContext.Provider value={ui}>
      <div className={studioClass}>
        <WorkbenchTopbar
          dramaTitle={wb.drama.title}
          onBack={() => navigate(`/drama/${wb.dramaId}`)}
          onHelp={() => startTour('episode', [...EPISODE_TOUR])}
        />

        <div className={studioBodyClass}>
          <WorkbenchSidebar />
          <main className={mainClass}>
            <StagePanels />
          </main>
          <TaskDrawer />
        </div>

        {assetDetail && <AssetDetailDialog kind={assetDetail.kind} id={assetDetail.id} onClose={() => setAssetDetail(null)} />}
        {assetCreateKind && (
          <AssetCreateDialog
            kind={assetCreateKind}
            onClose={() => setAssetCreateKind(null)}
            onSave={async (draft) => {
              await wb.saveAssetCreate(assetCreateKind, draft)
              toast.success(t('episode.create.created', { type: kindLabelOf(assetCreateKind) }))
              setAssetCreateKind(null)
            }}
          />
        )}
        {assetDelete && (
          <ConfirmDialog
            open
            title={t('episode.delete.title', { type: typeLabelOf(assetDelete.kind) })}
            message={t('episode.delete.message', { type: typeLabelOf(assetDelete.kind), name: assetDelete.name })}
            loading={deleting}
            onConfirm={() => {
              setDeleting(true)
              void wb
                .deleteAsset(assetDelete.kind, assetDelete.id)
                .then(() => {
                  toast.success(t('episode.delete.deleted', { type: typeLabelOf(assetDelete.kind) }))
                  setAssetDelete(null)
                  setAssetDetail(null)
                })
                .catch(() => undefined)
                .finally(() => setDeleting(false))
            }}
            onCancel={() => setAssetDelete(null)}
          />
        )}

        <ImageViewer open={image.open} src={image.src} title={image.title} onClose={() => setImage({ open: false, src: '', title: '' })} />
        {previewShot && previewShotSrc && (
          <VideoViewer
            open
            title={t('episode.export.shotPreview', { n: shotNumberOf(wb.sbs, previewShot) })}
            meta={previewShot.duration ? `${previewShot.duration}s` : ''}
            src={`/${previewShotSrc}`}
            downloadHref={`/${previewShotSrc}`}
            onClose={() => setPreviewShot(null)}
          />
        )}
        {activeMerge && (
          <VideoViewer
            open
            title={t('episode.viewer.filmPreview')}
            meta={`${formatHistoryTime(activeMerge.createdAt)}${activeMerge.duration ? ` · ${activeMerge.duration}s` : ''}`}
            src={`/${activeMerge.mergedUrl}`}
            downloadHref={`/${activeMerge.mergedUrl}`}
            downloadLabel={t('episode.viewer.downloadFilm')}
            onClose={() => setActiveMerge(null)}
          />
        )}
      </div>
    </WorkbenchUiContext.Provider>
  )
}

/** 主面板路由：script / production / export */
function StagePanels() {
  const stage = useWorkbenchStore((s) => s.stage)
  const wb = useWorkbench()
  const prodTab = useWorkbenchStore((s) => s.prodTab)

  if (stage === 'script') return <ScriptPanel />
  if (stage === 'production') {
    if (!wb.episode?.scriptContent) return <ProductionBlocked />
    return <div className={contentPanelClass}>{prodTab === 'assets' ? <AssetsPanel /> : <VideosPanel />}</div>
  }
  return <ExportPanel />
}

function ProductionBlocked() {
  const wb = useWorkbench()
  const { t } = useTranslation()
  const setStage = useWorkbenchStore((s) => s.setStage)
  const setScriptStep = useWorkbenchStore((s) => s.setScriptStep)
  const setProdTab = useWorkbenchStore((s) => s.setProdTab)
  return (
    <div className={contentPanelClass}>
      <div className={cn(stepEmptyClass, 'flex-1')}>
        <div className={emptyVisualClass}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
        </div>
        <div className={emptyTitleClass}>{t('episode.prod.notReady')}</div>
        <div className={emptyDescClass}>{t('episode.prod.scriptFirst')}</div>
        <button
          type="button"
          className={buttonVariants({ variant: 'primary' })}
          onClick={() => {
            if (!wb.episode?.content) {
              setStage('script')
              setScriptStep(wb.rawDraft ? 1 : 0)
              return
            }
            setStage('production')
            setProdTab('assets')
          }}
        >
          {wb.episode?.content ? t('episode.prod.goBack') : t('episode.export.gotoScript')}
        </button>
      </div>
    </div>
  )
}

function shotNumberOf(sbs: Storyboard[], sb: Storyboard): number {
  const i = sbs.findIndex((s) => s.id === sb?.id)
  return i >= 0 ? i + 1 : 0
}

/** 资产类型显示名（渲染时求值） */
function kindLabelOf(kind: AssetKind): string {
  return globalT(kind === 'character' ? 'common.role' : kind === 'scene' ? 'common.scene' : 'common.prop')
}

function typeLabelOf(kind: AssetKind): string {
  return globalT(kind === 'character' ? 'episode.asset.typeChar' : kind === 'scene' ? 'episode.asset.typeScene' : 'episode.asset.typeProp')
}
