/**
 * 项目详情页：集 CRUD、分辨率/状态手动标记、
 * 素材库（生图受理 + 轮询回写）、素材编辑与最终提示词、图片查看器。
 * 数据经 React Query；生图等待期以 refetchInterval 轮询项目详情，图片回写后自动收敛。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { dramaQueries } from '@/entities/drama/queries'
import { qk } from '@/shared/api/query-keys'
import { episodeApi } from '@/entities/episode/api'
import { assetApiOf } from '@/entities/asset/api'
import { uploadApi } from '@/shared/api/upload'
import { cn } from '@/shared/lib/cn'
import { toastError } from '@/shared/lib/errors'
import { thumbOf, thumbFallback } from '@/shared/lib/media'
import type { Drama } from '@/entities/drama/model'
import type { Episode } from '@/entities/episode/model'
import type { AssetKind } from '@/entities/asset/model'
import { BaseSelect } from '@/shared/ui/BaseSelect'
import { AppMenu } from '@/shared/ui/AppMenu'
import { AppMenuItem } from '@/shared/ui/AppMenuItem'
import { ConfirmDialog } from '@/shared/ui/ConfirmDialog'
import { Modal } from '@/shared/ui/Modal'
import { ImageViewer } from '@/shared/ui/media-viewers'
import { buttonVariants } from '@/shared/ui/button'
import { Badge, badgeVariants } from '@/shared/ui/badge'
import { cardVariants } from '@/shared/ui/card'
import { Input, Textarea } from '@/shared/ui/input'
import { RingSpinner } from '@/shared/ui/spinner'
import { buildMaterials, assetSrcOf, materialDesc, pendingKeyOf, type Material } from './materials'

const POLL_INTERVAL = 2500
const POLL_TIMEOUT = 100_000

/* ===== 迁移自 DramaDetailPage.module.css 的 Tailwind 类串（复用串提为常量，保持完整字符串便于扫描） ===== */
const PAGE =
  'h-full overflow-y-auto pt-5 px-7 pb-10 max-860:p-4 max-860:pb-8 animate-fade-up'

const PAGE_HEAD = cn(
  cardVariants(),
  'flex items-center gap-3 py-2.5 px-4 rounded-panel mb-[14px] max-860:flex-wrap',
)
const HEAD_INFO = 'flex-1 min-w-0 flex items-center gap-2.5 flex-wrap'
const PAGE_TITLE =
  'text-[17px] font-bold tracking-[-0.02em] leading-[1.2] whitespace-nowrap overflow-hidden text-ellipsis'
const PAGE_META = 'flex items-center gap-3.5 flex-wrap'
const META_ITEM = 'flex items-center gap-[5px] text-[12px] text-content-muted'
const BACK_BTN =
  'w-[30px] h-[30px] shrink-0 flex items-center justify-center border-none rounded-full bg-track text-content-secondary cursor-pointer transition-[background,color,box-shadow] duration-160 ease-app hover:bg-active-overlay hover:text-content focus-visible:outline-none focus-visible:shadow-focus'

const PAGE_TABS = 'flex items-center gap-1 border-b border-outline mb-[14px]'
const TAB_BTN =
  'relative inline-flex items-center gap-[7px] border-none bg-transparent pt-2 px-1 pb-2.5 mr-5 text-[13.5px] font-semibold text-content-muted cursor-pointer transition-[color] duration-160 ease-app [&>svg]:opacity-75 hover:text-content after:content-[""] after:absolute after:left-0 after:right-0 after:-bottom-px after:h-[2px] after:rounded-[2px] after:bg-transparent after:transition-[background] after:duration-160 after:ease-app'
const TAB_BTN_ON = 'text-content font-[650] after:bg-brand'
const TAB_COUNT =
  'inline-flex items-center justify-center min-w-[18px] h-[18px] px-[5px] rounded-[9px] text-[11px] font-bold font-code bg-elevated text-content-muted'
const TAB_COUNT_ON = 'bg-brand-soft text-brand-content'

const EP_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-[10px] max-860:grid-cols-1'
const EP_CARD =
  'relative flex flex-col gap-[10px] pt-3 px-[14px] pb-2.5 cursor-pointer animate-fade-up transition-[border-color,background] duration-180 ease-app hover:border-outline-strong'
const EP_CARD_TOP = 'flex items-center gap-3 min-w-0'
const EP_NUMBER =
  'w-10 h-10 shrink-0 rounded-control border border-outline flex flex-col items-center justify-center font-code bg-elevated text-content-secondary'
const EP_NUM_LABEL = 'text-[7.5px] tracking-[0.18em] font-semibold opacity-55 leading-none mb-px'
const EP_MAIN = 'flex-1 min-w-0 flex flex-col justify-center gap-0.5'
const EP_TITLE =
  'text-[13.5px] font-semibold leading-[1.35] text-content m-0 overflow-hidden text-ellipsis whitespace-nowrap'
const EP_META_ROW = 'flex items-center gap-2 flex-nowrap overflow-hidden whitespace-nowrap'
const EP_META =
  'inline-flex items-center gap-1 text-[11px] text-content-subtle whitespace-nowrap shrink-0 [&>svg]:opacity-70 [&>svg]:shrink-0'
const EP_TIME = 'shrink overflow-hidden text-ellipsis'
const EP_BADGES = 'flex items-center shrink-0'
const EP_CARD_FOOT = 'flex items-center gap-1.5 pt-[9px] border-t border-outline'
const EP_FOOT_SPACER = 'flex-1'
const EP_ENTER =
  'inline-flex items-center gap-1 py-1 px-3 border-none rounded-control bg-brand-soft text-brand-content text-[12px] font-semibold cursor-pointer transition-[background,color] duration-150 ease-[ease] whitespace-nowrap hover:bg-brand-gradient hover:text-on-action hover:shadow-[0_2px_8px_var(--hb-brand-glow)] [&>svg]:transition-transform [&>svg]:duration-180 [&>svg]:ease-app [&:hover>svg]:translate-x-[2px]'
const EP_STATUS_BTN = cn(
  badgeVariants(),
  'cursor-pointer border-none inline-flex items-center gap-[5px] py-[3px] px-[10px] rounded-dialog bg-elevated text-content-muted text-[11px] font-medium leading-[inherit] transition-[background,color] duration-140 ease-[ease] whitespace-nowrap hover:text-content hover:bg-sunken',
)
const EP_RES_BTN = cn(
  badgeVariants(),
  'cursor-pointer border-none inline-flex items-center py-[2px] px-2 rounded-[6px] text-[11px] font-semibold leading-[inherit] bg-elevated text-content-muted transition-[background,color] duration-140 ease-[ease] hover:bg-hover-overlay hover:text-content-secondary',
)
const STATUS_DOT = 'w-1.5 h-1.5 rounded-full shrink-0'
const EP_DELETE = 'text-content-subtle transition-[color] duration-150 ease-[ease] hover:text-danger'
const EP_EMPTY = cn(
  cardVariants(),
  'group flex flex-row items-center justify-center gap-2 min-h-[104px] p-2 text-center text-content-subtle text-[12.5px] border-dashed cursor-pointer transition-[border-color,color,background] duration-200 ease-[ease] hover:border-brand-content hover:text-brand-content hover:bg-brand-soft',
)
const EP_EMPTY_ICON =
  'w-7 h-7 rounded-full bg-elevated text-content-subtle flex items-center justify-center shrink-0 transition-[transform,background,color] duration-200 ease-[ease] group-hover:bg-brand-soft group-hover:text-brand-content'

const FIELD = 'flex flex-col gap-2'
const FIELD_LABEL = 'text-[12.5px] font-semibold text-content-secondary'
const FIELD_HINT = 'text-[12px] text-content-subtle'
const DIALOG_FOOT_COPY = 'mr-auto text-[12px] leading-[1.6] text-content-subtle max-860:hidden'

const EMPTY_STATE =
  'min-h-[280px] flex flex-col items-center justify-center gap-2.5 border border-dashed border-outline-strong rounded-panel bg-surface text-center'
const EMPTY_ICON = 'w-14 h-14 rounded-panel bg-elevated text-content-subtle flex items-center justify-center mb-1'
const EMPTY_TITLE = 'text-[14px] font-semibold text-content-secondary'
const EMPTY_DESC = 'text-[12px] text-content-subtle max-w-[260px] leading-[1.6]'

const ASSET_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3 items-stretch'
const CHARACTER_ASSET_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(230px,260px))] justify-start gap-[10px]'
const ASSET_GROUP_HEAD =
  'flex items-center gap-2 py-[7px] px-[14px] mt-1 mb-[14px] rounded-control border-l-[3px] border-l-content-subtle bg-surface text-[13.5px] font-bold text-content-secondary'
const GROUP_HEAD_KIND: Record<AssetKind, string> = {
  character: 'border-l-brand bg-brand-soft text-brand-content',
  scene: 'border-l-success bg-success-soft text-tag-success',
  prop: 'border-l-warning bg-warning-soft text-warn-text',
}
const GROUP_ICON = 'inline-flex text-content-muted'
const GROUP_ICON_KIND: Record<AssetKind, string> = {
  character: 'text-brand-content',
  scene: 'text-tag-success',
  prop: 'text-warn-text',
}
const GROUP_LABEL = 'tracking-[0.02em]'
const GROUP_COUNT =
  'ml-auto text-[11.5px] font-semibold text-content-subtle bg-elevated rounded-[99px] py-px px-[9px]'

const ASSET_CARD =
  'flex flex-col overflow-hidden transition-[transform,box-shadow,border-color] duration-180 ease-app hover:-translate-y-[2px] hover:shadow-raised'
const ASSET_CLICK_CARD =
  'cursor-pointer focus-visible:outline-none focus-visible:border-[color:var(--hb-brand-glow)] focus-visible:shadow-[0_0_0_3px_var(--hb-focus-ring),var(--hb-shadow-panel)]'
const CHARACTER_ASSET_CARD =
  'flex flex-col overflow-hidden min-h-0 cursor-pointer transition-[transform,box-shadow,border-color] duration-180 ease-app hover:-translate-y-[2px] hover:shadow-raised hover:border-outline-strong focus-visible:outline-none focus-visible:border-[color:var(--hb-brand-glow)] focus-visible:shadow-[0_0_0_3px_var(--hb-focus-ring),var(--hb-shadow-panel)]'
const CHARACTER_PORTRAIT =
  'relative w-full aspect-video self-start m-0 border border-outline rounded-control bg-elevated overflow-hidden'
const CHARACTER_PORTRAIT_EMPTY = 'w-full h-full flex items-center justify-center text-content-subtle'
const CHARACTER_ASSET_MAIN = 'min-w-0 w-full p-2 flex flex-col gap-2'
const CHARACTER_ASSET_OVERVIEW = 'flex flex-col gap-2'
const CHARACTER_ASSET_HEAD = 'flex items-center justify-between gap-2 min-w-0'
const CHARACTER_TITLE_BLOCK = 'min-w-0 flex flex-col gap-1'
const CHARACTER_NAME_ROW = 'flex items-center gap-[5px] min-w-0 flex-wrap'
const CHARACTER_NAME = 'text-[13px] leading-[1.25] text-content'
const CHARACTER_GEN_BTN = 'shrink-0 self-center'
const CHARACTER_VISUAL_SUMMARY =
  'max-w-full flex gap-2 overflow-hidden text-content-subtle text-[10.5px] leading-[1.45] whitespace-nowrap'
const VISUAL_SUMMARY_SPAN = 'min-w-0 overflow-hidden text-ellipsis'
const ASSET_FINAL_PROMPT = 'flex flex-col gap-0.5 pt-[7px] border-t border-outline text-[10.5px] leading-[1.5]'
const AFP_LABEL = 'text-[9.5px] font-bold tracking-[0.05em] text-content-subtle'
const AFP_TEXT = 'line-clamp-2 break-words text-content-muted'
const ASSET_FINAL = 'line-clamp-2 break-words text-content-muted'
const ASSET_COVER = 'relative aspect-square bg-elevated overflow-hidden'
const ASSET_COVER_WIDE = 'aspect-video'
const ASSET_COVER_BADGE =
  'absolute top-[7px] left-[7px] inline-flex items-center py-[2px] px-[7px] rounded-[999px] bg-header backdrop-blur-[10px] shadow-item text-content-muted text-[9.5px] font-bold'
const BADGE_READY = 'bg-success-soft text-tag-success'
const BADGE_PENDING = 'bg-brand-soft text-brand-content'
const ASSET_COVER_EMPTY = 'w-full h-full flex items-center justify-center text-content-subtle'
const ASSET_BODY = 'flex-1 flex flex-col gap-[3px] pt-[9px] px-[11px] pb-2 min-w-0'
const ASSET_NAME = 'text-[13px] font-[650] text-content whitespace-nowrap overflow-hidden text-ellipsis'
const ASSET_META = 'text-[11px] leading-[1.5]'
const ASSET_DESC = 'line-clamp-2 break-words'
const ASSET_LIGHT = 'whitespace-nowrap overflow-hidden text-ellipsis'
const ASSET_FOOT = 'flex items-center gap-1 py-[7px] px-[11px] border-t border-outline'
const PROP_NAME_ROW = 'flex items-center justify-between gap-2'
const DOT = 'w-[7px] h-[7px] rounded-full bg-sunken shrink-0'

/* 原 .seg/.seg-item/.on（旧全局类）的 Tailwind 等价串 */
const SEG_ITEM =
  'cursor-pointer rounded-pill border-none bg-transparent px-4 py-[7px] text-[12.5px] font-semibold leading-none text-content-muted transition-all duration-150 ease-app hover:text-content focus-visible:outline-none focus-visible:shadow-focus'
const SEG_ITEM_ON = 'bg-seg-active text-content shadow-[0_1px_4px_rgba(0,0,0,0.12)]'

const MAT_DETAIL_TITLE_BLOCK = 'min-w-0 flex flex-col gap-1'
const MAT_DETAIL_KICKER = 'text-content-subtle text-[10px] font-extrabold tracking-[0.12em] uppercase'
const MAT_DETAIL_TITLE = 'm-0 text-content text-[18px] leading-[1.2] font-display'
const MAT_DETAIL_SECONDARY_ACTIONS = 'flex min-w-0 max-w-full flex-wrap items-center gap-2'
const MAT_DETAIL_PRIMARY_ACTIONS = 'ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2'
const MAT_DETAIL_SHELL = 'grid grid-cols-[minmax(280px,380px)_minmax(0,1fr)] gap-[14px] items-start max-1080:grid-cols-1'
const MAT_DETAIL_PREVIEW_PANEL = 'min-w-0 flex flex-col gap-3 sticky top-0 max-1080:static'
const MAT_DETAIL_EDITOR_PANEL = 'min-w-0 flex flex-col gap-3'
const MAT_DETAIL_SECTION_TITLE =
  'min-h-6 flex items-center justify-between gap-[10px] text-content-secondary text-[12px] font-[820] tracking-[0.02em]'
const SECTION_TITLE_DIM = 'text-[11px] font-[560] tracking-normal text-right'
const MAT_DETAIL_STATE =
  'min-h-5 inline-flex items-center px-[7px] rounded-[999px] bg-track text-content-subtle text-[10px] font-[760] whitespace-nowrap'
const MAT_DETAIL_STATE_READY = 'bg-success-soft text-success'
const MAT_DETAIL_MEDIA_FRAME =
  'relative w-full aspect-video block p-0 border border-outline rounded-control bg-elevated text-content-subtle overflow-hidden cursor-zoom-in disabled:cursor-default disabled:opacity-100 focus-visible:outline-none focus-visible:border-action-primary focus-visible:shadow-[0_0_0_3px_var(--hb-focus-ring)]'
const MAT_DETAIL_MEDIA_EMPTY = 'w-full h-full flex items-center justify-center text-content-subtle'
const MAT_DETAIL_META_ROW = 'grid grid-cols-2 gap-2'
const MAT_DETAIL_META_ITEM = 'min-w-0 py-[9px] px-[10px] border border-outline rounded-control bg-surface-muted'
const META_ITEM_LABEL = 'block text-content-subtle text-[10px] font-[780] tracking-[0.04em]'
const META_ITEM_VALUE =
  'block mt-1 min-w-0 text-content text-[12px] leading-[1.35] overflow-hidden text-ellipsis whitespace-nowrap'
const MAT_DETAIL_EDIT_FIELD = 'min-w-0 flex flex-col gap-[7px]'
const EDIT_FIELD_LABEL = 'text-content-subtle text-[10px] font-[780] tracking-[0.04em]'
const EDIT_FIELD_INPUT =
  'placeholder:text-content-subtle placeholder:text-[10px] placeholder:font-[780] placeholder:tracking-[0.04em]'
const MAT_DETAIL_PROMPT_PANEL = 'mt-[18px] border-t border-outline pt-4'
const MAT_DETAIL_PROMPT_GEN = 'ml-auto shrink-0 inline-flex items-center gap-[5px]'

type EditDraft = Partial<{
  name: string
  role: string
  appearance: string
  styling: string
  description: string
  location: string
  time: string
  prompt: string
  lighting: string
  type: string
  finalPrompt: string
}>

export function DramaDetailPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const params = useParams()
  const dramaId = Number(params.id)

  const validDramaId = Number.isInteger(dramaId) && dramaId > 0

  // ===== 数据 =====
  const [pendingMaterials, setPendingMaterials] = useState<Map<string, number>>(new Map())
  const [uploadingMaterials, setUploadingMaterials] = useState<Set<string>>(new Set())

  const dramaQuery = useQuery({
    ...dramaQueries.detail(dramaId),
    enabled: validDramaId,
    refetchInterval: pendingMaterials.size > 0 ? POLL_INTERVAL : false,
    retry: false,
  })
  const drama: Drama | undefined = dramaQuery.data

  const invalidateDrama = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: qk.dramaDetail(dramaId) })
    void queryClient.invalidateQueries({ queryKey: qk.dramas() })
  }, [queryClient, dramaId])

  // ===== 集 CRUD =====
  const [addDialog, setAddDialog] = useState(false)
  const [newEpisodeTitle, setNewEpisodeTitle] = useState('')
  const [newEpisodeResolution, setNewEpisodeResolution] = useState('720p')
  const [episodeToDelete, setEpisodeToDelete] = useState<Episode | null>(null)

  const resolutionOptions = useMemo(
    () => [
      { label: t('detail.ep.res720'), value: '720p' },
      { label: t('detail.ep.res480'), value: '480p' },
    ],
    [t],
  )
  const epStatusOptions = useMemo(
    () => [
      { label: t('index.status.draft'), value: 'draft' },
      { label: t('index.status.active'), value: 'active' },
      { label: t('index.status.completed'), value: 'completed' },
    ],
    [t],
  )

  function epResolution(ep: Episode): string {
    return ep.resolution === '480p' ? '480p' : '720p'
  }
  function epStatus(ep: Episode): string {
    return ep.status || 'draft'
  }

  // 分辨率/状态：乐观更新 + 回滚（小字段）
  const updateEpisodeMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) => episodeApi.update(id, data),
    onMutate: async ({ id, data }) => {
      await queryClient.cancelQueries({ queryKey: qk.dramaDetail(dramaId) })
      const prev = queryClient.getQueryData<Drama>(qk.dramaDetail(dramaId))
      if (prev) {
        queryClient.setQueryData<Drama>(qk.dramaDetail(dramaId), {
          ...prev,
          episodes: prev.episodes.map((e) => (e.id === id ? { ...e, ...data } : e)),
        })
      }
      return { prev }
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(qk.dramaDetail(dramaId), ctx.prev)
      toastError(err)
    },
    onSettled: () => invalidateDrama(),
  })

  function setEpisodeResolution(ep: Episode, resolution: string) {
    if (epResolution(ep) === resolution) return
    updateEpisodeMutation.mutate(
      { id: ep.id, data: { resolution } },
      { onSuccess: () => toast.success(t('detail.ep.resSwitched', { res: resolution })) },
    )
  }

  function setEpisodeStatus(ep: Episode, status: string) {
    if (epStatus(ep) === status) return
    updateEpisodeMutation.mutate({ id: ep.id, data: { status } })
  }

  const addEpisodeMutation = useMutation({
    mutationFn: () =>
      // 图片/视频生成配置由后端自动锁定为当前启用的最高优先级配置；分辨率随集固定
      episodeApi.create({
        drama_id: dramaId,
        title: newEpisodeTitle || undefined,
        resolution: newEpisodeResolution,
      }),
    onSuccess: () => {
      toast.success(t('detail.epCreate.added'))
      setAddDialog(false)
      invalidateDrama()
    },
    onError: (err) => toastError(err),
  })

  const deleteEpisodeMutation = useMutation({
    mutationFn: (id: number) => episodeApi.del(id),
    onSuccess: () => {
      toast.success(t('index.deleted'))
      setEpisodeToDelete(null)
      invalidateDrama()
    },
    onError: (err) => toastError(err),
  })

  // ===== 主 Tab / 素材库 =====
  const [activeTab, setActiveTab] = useState<'episodes' | 'assets'>('episodes')
  const [assetTab, setAssetTab] = useState<'all' | AssetKind>('all')
  const [viewer, setViewer] = useState<{ open: boolean; src: string; title: string }>({ open: false, src: '', title: '' })

  const kindLabels = useMemo(
    () => ({
      character: t('common.role'),
      scene: t('common.scene'),
      prop: t('common.prop'),
    }),
    [t],
  ) as Record<AssetKind, string>

  const materials = useMemo(
    () => (drama ? buildMaterials(drama, kindLabels) : []),
    [drama, kindLabels],
  )
  const visibleAssets = useMemo(
    () => (assetTab === 'all' ? materials : materials.filter((m) => m.kindKey === assetTab)),
    [materials, assetTab],
  )
  const assetTotal = materials.length
  const assetGroups = useMemo(
    () =>
      (
        [
          { kindKey: 'character' as const, label: kindLabels.character, items: materials.filter((m) => m.kindKey === 'character') },
          { kindKey: 'scene' as const, label: kindLabels.scene, items: materials.filter((m) => m.kindKey === 'scene') },
          { kindKey: 'prop' as const, label: kindLabels.prop, items: materials.filter((m) => m.kindKey === 'prop') },
        ] as const
      ).filter((g) => assetTab === 'all' || g.kindKey === assetTab),
    [materials, assetTab, kindLabels],
  )

  // 生图受理 → 轮询回写：图片出现（或超时）后移出 pending
  useEffect(() => {
    if (!pendingMaterials.size || !drama) return
    const lists: Record<AssetKind, { id: number; image: string }[]> = {
      character: drama.characters.map((c) => ({ id: c.id, image: c.imageUrl || c.localPath })),
      scene: drama.scenes.map((s) => ({ id: s.id, image: s.imageUrl || s.localPath })),
      prop: drama.props.map((p) => ({ id: p.id, image: p.imageUrl || p.localPath })),
    }
    const next = new Map(pendingMaterials)
    let changed = false
    for (const [key, startedAt] of pendingMaterials) {
      const [kindKey, idStr] = key.split(':') as [AssetKind, string]
      const rec = lists[kindKey]?.find((x) => x.id === Number(idStr))
      if (rec?.image) {
        next.delete(key)
        changed = true
      } else if (Date.now() - startedAt > POLL_TIMEOUT) {
        next.delete(key)
        changed = true
        const mat = materials.find((m) => pendingKeyOf(m.kindKey, m.id) === key)
        if (mat) toast.info(t('detail.mat.genTimeout', { kind: mat.kind, name: mat.name }))
      }
    }
    if (changed) setPendingMaterials(next)
    // materials 由 drama 派生，避免循环依赖

  }, [drama, pendingMaterials])

  const isPending = useCallback(
    (m: Material) => pendingMaterials.has(pendingKeyOf(m.kindKey, m.id)),
    [pendingMaterials],
  )
  const isUploading = useCallback(
    (m: Material) => uploadingMaterials.has(pendingKeyOf(m.kindKey, m.id)),
    [uploadingMaterials],
  )

  const generateMaterial = useCallback(
    async (m: Material) => {
      const epId = drama?.episodes[0]?.id
      if (!epId) {
        toast.error(t('detail.mat.needEpisodeForImage'))
        return
      }
      const key = pendingKeyOf(m.kindKey, m.id)
      if (pendingMaterials.has(key)) return
      setPendingMaterials((prev) => new Map(prev).set(key, Date.now()))
      try {
        await assetApiOf(m.kindKey).generateImage(m.id, { episodeId: epId })
        toast.success(t('detail.mat.generating', { kind: m.kind, name: m.name }))
      } catch (err) {
        setPendingMaterials((prev) => {
          const next = new Map(prev)
          next.delete(key)
          return next
        })
        toastError(err)
      }
    },
    [drama, pendingMaterials, t],
  )

  const uploadMaterial = useCallback(
    (m: Material) => {
      const key = pendingKeyOf(m.kindKey, m.id)
      if (uploadingMaterials.has(key)) return
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp'
      input.onchange = async () => {
        const file = input.files?.[0]
        if (!file) return
        setUploadingMaterials((prev) => new Set(prev).add(key))
        try {
          const res = await uploadApi.image(file)
          // 与生图回写保持一致：存相对路径（static/...），展示时补前导斜杠
          const payload = { image_url: res.path, local_path: res.path }
          await assetApiOf(m.kindKey).update(m.id, payload)
          toast.success(t('detail.mat.uploaded', { kind: m.kind, name: m.name }))
          invalidateDrama()
          setEditTarget((prev) =>
            prev && prev.kindKey === m.kindKey && prev.id === m.id ? { ...prev, image: res.path } : prev,
          )
        } catch (err) {
          toastError(err)
        } finally {
          setUploadingMaterials((prev) => {
            const next = new Set(prev)
            next.delete(key)
            return next
          })
        }
      }
      input.click()
    },
    [uploadingMaterials, t, invalidateDrama],
  )

  // ===== 素材编辑 =====
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Material | null>(null)
  const [editDraft, setEditDraft] = useState<EditDraft>({})
  const [editSaving, setEditSaving] = useState(false)
  const [finalPromptGen, setFinalPromptGen] = useState(false)

  function openEdit(m: Material) {
    setEditTarget(m)
    if (m.kindKey === 'character') {
      setEditDraft({
        name: m.name,
        role: m.character?.role ?? '',
        appearance: m.character?.appearance ?? '',
        styling: m.character?.styling ?? '',
        description: m.character?.description ?? '',
        finalPrompt: m.finalPrompt ?? '',
      })
    } else if (m.kindKey === 'scene') {
      setEditDraft({
        location: m.scene?.location ?? '',
        time: m.scene?.time ?? '',
        prompt: m.scene?.prompt ?? '',
        lighting: m.scene?.lighting ?? '',
        finalPrompt: m.finalPrompt ?? '',
      })
    } else {
      setEditDraft({
        name: m.name,
        type: m.prop?.type ?? '',
        description: m.prop?.description ?? '',
        finalPrompt: m.finalPrompt ?? '',
      })
    }
    setEditDialogOpen(true)
  }

  const firstEpisodeId = drama?.episodes[0]?.id ?? null

  async function generateFinalPrompt(m: Material) {
    const epId = firstEpisodeId
    if (!epId) {
      toast.error(t('detail.mat.needEpisodeForPrompt'))
      return
    }
    setFinalPromptGen(true)
    try {
      const res = await assetApiOf(m.kindKey).generatePrompt(m.id, epId, true)
      const fp = res?.final_prompt
      if (!fp) throw new Error(t('episode.asset.promptGenFailedRetry'))
      setEditTarget((prev) => (prev ? { ...prev, finalPrompt: fp } : prev))
      setEditDraft((prev) => ({ ...prev, finalPrompt: fp }))
      toast.success(t('episode.asset.promptGenerated'))
    } catch (err) {
      toastError(err)
    } finally {
      setFinalPromptGen(false)
    }
  }

  async function saveEdit() {
    const target = editTarget
    if (!target) return
    // 必填校验
    if (target.kindKey === 'character' && !String(editDraft.name ?? '').trim()) {
      toast.error(t('episode.create.nameRequired'))
      return
    }
    if (target.kindKey === 'scene' && !String(editDraft.location ?? '').trim()) {
      toast.error(t('detail.mat.locationRequired'))
      return
    }
    if (target.kindKey === 'prop' && !String(editDraft.name ?? '').trim()) {
      toast.error(t('episode.create.nameRequired'))
      return
    }
    setEditSaving(true)
    try {
      const fp = editDraft.finalPrompt || null
      if (target.kindKey === 'character') {
        await assetApiOf('character').update(target.id, {
          name: editDraft.name,
          role: editDraft.role,
          appearance: editDraft.appearance,
          description: editDraft.description,
          styling: editDraft.styling,
          finalPrompt: fp,
        })
      } else if (target.kindKey === 'scene') {
        await assetApiOf('scene').update(target.id, {
          location: editDraft.location,
          time: editDraft.time,
          prompt: editDraft.prompt,
          lighting: editDraft.lighting,
          finalPrompt: fp,
        })
      } else {
        await assetApiOf('prop').update(target.id, {
          name: editDraft.name,
          type: editDraft.type,
          description: editDraft.description,
          finalPrompt: fp,
        })
      }
      toast.success(t('common.saved'))
      setEditDialogOpen(false)
      setEditTarget(null)
      invalidateDrama()
    } catch (err) {
      toastError(err)
    } finally {
      setEditSaving(false)
    }
  }

  function formatEpTime(ts: string): string {
    if (!ts) return ''
    const d = new Date(ts)
    const diff = Date.now() - d.getTime()
    if (diff < 60_000) return t('index.time.justNow')
    if (diff < 3_600_000) return t('index.time.minutesAgo', { n: Math.floor(diff / 60_000) })
    if (diff < 86_400_000) return t('index.time.hoursAgo', { n: Math.floor(diff / 3_600_000) })
    return `${d.getMonth() + 1}/${d.getDate()}`
  }

  // ===== 错误/加载态 =====
  if (!validDramaId || dramaQuery.isError) {
    return (
      <div className={PAGE} style={{ padding: 32 }}>
        <p className="text-content-subtle">
          {dramaQuery.error instanceof Error && dramaQuery.error.message
            ? dramaQuery.error.message
            : t('errors.unknown')}
        </p>
      </div>
    )
  }
  if (!drama) {
    return (
      <div className={PAGE}>
        <p className="text-content-subtle">{t('common.loading')}</p>
      </div>
    )
  }
  if (drama.projectType === 'creative') return <Navigate to={`/creative/${drama.id}`} replace />

  const tabLabel = (v: string) =>
    v === 'all' ? t('index.status.all') : v === 'character' ? t('common.role') : v === 'scene' ? t('common.scene') : t('common.prop')

  return (
    <div className={PAGE}>
      {/* Header：单行紧凑 */}
      <div className={PAGE_HEAD}>
        <button type="button" className={BACK_BTN} title={t('common.back')} onClick={() => navigate('/')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
          </svg>
        </button>
        <div className={HEAD_INFO}>
          <h1 className={PAGE_TITLE}>{drama.title}</h1>
          {drama.style && <Badge tone="brand">{drama.style}</Badge>}
          <div className={PAGE_META}>
            <span className={META_ITEM}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
              {t('detail.head.charCount', { n: drama.characters.length })}
            </span>
            <span className={META_ITEM}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /></svg>
              {t('detail.head.sceneCount', { n: drama.scenes.length })}
            </span>
            <span className={META_ITEM}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.5" /><line x1="7" y1="8" x2="7" y2="16" /><line x1="10" y1="8" x2="10" y2="16" /><line x1="13" y1="8" x2="13" y2="16" /><line x1="16" y1="8" x2="16" y2="16" /></svg>
              {t('detail.head.epCount', { n: drama.episodes.length })}
            </span>
          </div>
        </div>
        <button
          type="button"
          className={cn(buttonVariants({ variant: 'primary' }), 'head-action')}
          onClick={() => { setNewEpisodeTitle(''); setNewEpisodeResolution('720p'); setAddDialog(true) }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          {t('detail.head.addEpisode')}
        </button>
      </div>

      {/* 主 Tab：剧集列表 / 素材库 */}
      <nav className={PAGE_TABS}>
        <button
          type="button"
          className={cn(TAB_BTN, activeTab === 'episodes' && TAB_BTN_ON)}
          onClick={() => setActiveTab('episodes')}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.5" /><line x1="7" y1="8" x2="7" y2="16" /><line x1="10" y1="8" x2="10" y2="16" /><line x1="13" y1="8" x2="13" y2="16" /><line x1="16" y1="8" x2="16" y2="16" /></svg>
          {t('detail.tabs.episodes')}
          <span className={cn(TAB_COUNT, activeTab === 'episodes' && TAB_COUNT_ON)}>{drama.episodes.length}</span>
        </button>
        <button
          type="button"
          className={cn(TAB_BTN, activeTab === 'assets' && TAB_BTN_ON)}
          onClick={() => setActiveTab('assets')}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
          {t('detail.tabs.assets')}
          {assetTotal > 0 && <span className={cn(TAB_COUNT, activeTab === 'assets' && TAB_COUNT_ON)}>{assetTotal}</span>}
        </button>
      </nav>

      {activeTab === 'episodes' ? (
        <div className={EP_GRID}>
          {drama.episodes.map((ep, i) => {
            const status = epStatus(ep)
            const goto = () => navigate(`/drama/${drama.id}/episode/${ep.episodeNumber}`)
            return (
              <div
                key={ep.id}
                className={cn(cardVariants(), EP_CARD)}
                style={{ animationDelay: `${i * 0.05}s` }}
                onClick={goto}
              >
                {/* 上区：编号 + 标题元数据 + 状态 */}
                <div className={EP_CARD_TOP}>
                  <div className={EP_NUMBER}>
                    <span className={EP_NUM_LABEL}>EP</span>
                    <b className="text-[15px] font-semibold leading-none">{String(ep.episodeNumber).padStart(2, '0')}</b>
                  </div>
                  <div className={EP_MAIN}>
                    <h3 className={EP_TITLE}>{ep.title}</h3>
                    <div className={EP_META_ROW}>
                      {!!ep.duration && (
                        <span className={EP_META}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                          {ep.duration}s
                        </span>
                      )}
                      {!!ep.scriptContent && (
                        <span className={cn(EP_META, 'text-content-muted')}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>
                          {t('detail.ep.scriptReady')}
                        </span>
                      )}
                      {!!ep.videoUrl && (
                        <span className={cn(EP_META, 'text-content-muted')}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
                          {t('detail.ep.merged')}
                        </span>
                      )}
                      {!!ep.updatedAt && <span className={cn(EP_META, EP_TIME)}>{formatEpTime(ep.updatedAt)}</span>}
                    </div>
                  </div>
                  <div className={EP_BADGES} onClick={(e) => e.stopPropagation()}>
                    <AppMenu
                      placement="bottom-end"
                      minWidth={110}
                      trigger={() => (
                        <button type="button" className={EP_STATUS_BTN} title={t('detail.ep.statusTitle')}>
                          <span className={cn(STATUS_DOT, status === 'active' ? 'bg-success' : status === 'completed' ? 'bg-brand' : 'bg-content-subtle')} />
                          {epStatusOptions.find((o) => o.value === status)?.label ?? t('index.status.draft')}
                        </button>
                      )}
                    >
                      {epStatusOptions.map((s) => (
                        <AppMenuItem
                          key={s.value}
                          selected={status === s.value}
                          onClick={() => setEpisodeStatus(ep, s.value)}
                        >
                          {s.label}
                        </AppMenuItem>
                      ))}
                    </AppMenu>
                  </div>
                </div>

                {/* 下区：常驻操作条 — 分辨率 / 删除 / 进入制作 */}
                <div className={EP_CARD_FOOT} onClick={(e) => e.stopPropagation()}>
                  <AppMenu
                    placement="top-start"
                    minWidth={110}
                    trigger={() => (
                      <button type="button" className={EP_RES_BTN} title={t('detail.ep.resTitle')}>
                        {epResolution(ep)}
                      </button>
                    )}
                  >
                    {resolutionOptions.map((r) => (
                      <AppMenuItem
                        key={r.value}
                        selected={epResolution(ep) === r.value}
                        onClick={() => setEpisodeResolution(ep, r.value)}
                      >
                        {r.label}
                      </AppMenuItem>
                    ))}
                  </AppMenu>
                  <span className={EP_FOOT_SPACER} />
                  <button
                    className={cn(buttonVariants({ size: 'icon' }), 'size-[30px] min-w-[30px] min-h-[30px]', EP_DELETE)}
                    type="button"
                    title={t('detail.ep.deleteTitle')}
                    onClick={() => setEpisodeToDelete(ep)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                  <button type="button" className={EP_ENTER} onClick={goto}>
                    {t('detail.ep.enter')}
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                </div>
              </div>
            )
          })}

          {/* Empty episode state（点击也可直接添加第一集） */}
          {!drama.episodes.length ? (
            <div
              className={cn(cardVariants(), EP_EMPTY)}
              role="button"
              tabIndex={0}
              title={t('detail.ep.emptyCreateTitle')}
              onClick={() => setAddDialog(true)}
              onKeyDown={(e) => e.key === 'Enter' && setAddDialog(true)}
            >
              <div className={EP_EMPTY_ICON}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" />
                </svg>
              </div>
              <p>{t('detail.ep.emptyCreateText')}</p>
            </div>
          ) : (
            /* 已有剧集时，列表末尾常驻「添加下一集」卡片 */
            <div
              className={cn(cardVariants(), EP_EMPTY)}
              role="button"
              tabIndex={0}
              title={t('detail.ep.addNextTitle', { n: drama.episodes.length + 1 })}
              onClick={() => setAddDialog(true)}
              onKeyDown={(e) => e.key === 'Enter' && setAddDialog(true)}
            >
              <div className={EP_EMPTY_ICON}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" />
                </svg>
              </div>
              <p>{t('detail.ep.addNextText', { n: drama.episodes.length + 1 })}</p>
            </div>
          )}
        </div>
      ) : (
        <div>
          <div className="inline-flex gap-0.5 rounded-pill bg-track p-[3px] asset-filter">
            {(['all', 'character', 'scene', 'prop'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={cn(
                  SEG_ITEM,
                  assetTab === v && SEG_ITEM_ON,
                )}
                onClick={() => setAssetTab(v)}
              >
                {tabLabel(v)}
              </button>
            ))}
          </div>

          {!materials.length ? (
            <div className={EMPTY_STATE}>
              <div className={EMPTY_ICON}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
                </svg>
              </div>
              <p className={EMPTY_TITLE}>{t('detail.assets.emptyTitle')}</p>
              <p className={EMPTY_DESC}>{t('detail.assets.emptyDesc')}</p>
            </div>
          ) : (
            <div>
              {assetGroups.map((g) =>
                g.items.length > 0 ? (
                  <div key={g.kindKey}>
                    {assetTab === 'all' && (
                      <div className={cn(ASSET_GROUP_HEAD, GROUP_HEAD_KIND[g.kindKey])}>
                        <span className={cn(GROUP_ICON, GROUP_ICON_KIND[g.kindKey])}>
                          {g.kindKey === 'character' && (
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                          )}
                          {g.kindKey === 'scene' && (
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 12-9 12s-9-5-9-12a9 9 0 0 1 18 0Z" /><circle cx="12" cy="10" r="3" /></svg>
                          )}
                          {g.kindKey === 'prop' && (
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="M3.27 6.96 12 12l8.73-5.04M12 22.08V12" /></svg>
                          )}
                        </span>
                        <span className={GROUP_LABEL}>{g.label}</span>
                        <span className={GROUP_COUNT}>{g.items.length}</span>
                      </div>
                    )}

                    {g.kindKey === 'character' ? (
                      /* 角色：横向布局卡片（头像 + 样貌/妆造 + 三视图提示词） */
                      <div className={CHARACTER_ASSET_GRID}>
                        {g.items.map((m) => (
                          <article
                            key={`character-${m.id}`}
                            className={cn(cardVariants(), CHARACTER_ASSET_CARD)}
                            tabIndex={0}
                            role="button"
                            onClick={() => openEdit(m)}
                            onKeyDown={(e) => e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openEdit(m))}
                          >
                            <div className={CHARACTER_ASSET_MAIN}>
                              <div className={CHARACTER_ASSET_OVERVIEW}>
                                <div className={CHARACTER_PORTRAIT}>
                                  {m.image ? (
                                    <img
                                      src={thumbOf(assetSrcOf(m.image))}
                                      className="previewable-image w-full h-full object-cover block"
                                      loading="lazy"
                                      onError={(e) => thumbFallback(e, assetSrcOf(m.image))}
                                      onClick={(e) => { e.stopPropagation(); setViewer({ open: true, src: assetSrcOf(m.image), title: `${m.kind} · ${m.name}` }) }}
                                    />
                                  ) : (
                                    <div className={CHARACTER_PORTRAIT_EMPTY}>
                                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                                    </div>
                                  )}
                                  <span className={cn(ASSET_COVER_BADGE, m.image ? BADGE_READY : isPending(m) ? BADGE_PENDING : undefined)}>
                                    {m.image ? t('episode.asset.portraitReady') : isPending(m) ? t('episode.asset.portraitPending') : t('episode.asset.portraitTodo')}
                                  </span>
                                </div>
                                <div className={CHARACTER_ASSET_HEAD}>
                                  <div className={CHARACTER_TITLE_BLOCK}>
                                    <div className={CHARACTER_NAME_ROW}>
                                      <strong className={CHARACTER_NAME}>{m.name}</strong>
                                      <Badge>{m.character?.role || t('common.role')}</Badge>
                                    </div>
                                    <div className={CHARACTER_VISUAL_SUMMARY} title={materialDesc(m)}>
                                      <span className={VISUAL_SUMMARY_SPAN}>{t('episode.asset.appearance')}{m.character?.appearance || t('detail.assets.todoShort')}</span>
                                      <span className={VISUAL_SUMMARY_SPAN}>{t('episode.asset.styling')}{m.character?.styling || t('detail.assets.todoShort')}</span>
                                    </div>
                                  </div>
                                  <button
                                    className={cn(buttonVariants({ size: 'sm' }), CHARACTER_GEN_BTN)}
                                    type="button"
                                    disabled={isPending(m)}
                                    onClick={(e) => { e.stopPropagation(); void generateMaterial(m) }}
                                  >
                                    {isPending(m) && <RingSpinner size="sm" />}
                                    {m.image ? t('episode.asset.regen') : isPending(m) ? t('episode.asset.generating') : t('episode.asset.generate')}
                                  </button>
                                  <button
                                    className={buttonVariants({ size: 'sm' })}
                                    type="button"
                                    title={t('episode.asset.uploadCharImage')}
                                    disabled={isUploading(m)}
                                    onClick={(e) => { e.stopPropagation(); uploadMaterial(m) }}
                                  >
                                    {isUploading(m) ? (
                                      <RingSpinner size="sm" />
                                    ) : (
                                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                                    )}
                                    {t('episode.asset.upload')}
                                  </button>
                                </div>
                              </div>
                              <div className={ASSET_FINAL_PROMPT} title={m.finalPrompt}>
                                <span className={AFP_LABEL}>{t('episode.asset.finalPromptTurnaround')}</span>
                                <span className={cn(AFP_TEXT, !m.finalPrompt && 'text-content-subtle')}>
                                  {m.finalPrompt || t('episode.asset.finalPromptAutoTurnaround')}
                                </span>
                              </div>
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : (
                      /* 场景 / 道具：竖向布局卡片 */
                      <div className={ASSET_GRID}>
                        {g.items.map((m) => (
                          <div
                            key={`${g.kindKey}-${m.id}`}
                            className={cn(cardVariants(), ASSET_CARD, ASSET_CLICK_CARD)}
                            tabIndex={0}
                            role="button"
                            onClick={() => openEdit(m)}
                            onKeyDown={(e) => e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openEdit(m))}
                          >
                            <div className={cn(ASSET_COVER, ASSET_COVER_WIDE)}>
                              {m.image ? (
                                <img
                                  src={thumbOf(assetSrcOf(m.image))}
                                  className="previewable-image w-full h-full object-cover"
                                  loading="lazy"
                                  onError={(e) => thumbFallback(e, assetSrcOf(m.image))}
                                  onClick={(e) => { e.stopPropagation(); setViewer({ open: true, src: assetSrcOf(m.image), title: `${m.kind} · ${m.name}` }) }}
                                />
                              ) : (
                                <div className={ASSET_COVER_EMPTY}>
                                  {g.kindKey === 'scene' ? (
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" /></svg>
                                  ) : (
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></svg>
                                  )}
                                </div>
                              )}
                              <span className={cn(ASSET_COVER_BADGE, m.image ? BADGE_READY : isPending(m) ? BADGE_PENDING : undefined)}>
                                {m.image ? t('episode.asset.ready') : isPending(m) ? t('episode.asset.generating') : t('episode.asset.todo')}
                              </span>
                            </div>
                            <div className={ASSET_BODY}>
                              {g.kindKey === 'scene' ? (
                                <>
                                  <div className={ASSET_NAME} title={m.scene?.location}>{m.scene?.location}</div>
                                  <div className={cn(ASSET_META, ASSET_DESC, 'text-content-subtle')} title={materialDesc(m)}>
                                    {materialDesc(m) || t('episode.asset.sceneDescTodo')}
                                  </div>
                                  {!!m.scene?.lighting && (
                                    <div className={cn(ASSET_META, ASSET_LIGHT, 'text-content-subtle')} title={m.scene.lighting}>
                                      {t('episode.asset.lighting')}{m.scene.lighting}
                                    </div>
                                  )}
                                </>
                              ) : (
                                <>
                                  <div className={PROP_NAME_ROW}>
                                    <span className={`${ASSET_NAME} min-w-0`} title={m.name}>{m.name}</span>
                                    <Badge>{m.prop?.type || t('common.prop')}</Badge>
                                  </div>
                                  <div className={cn(ASSET_META, ASSET_DESC, 'text-content-subtle')} title={m.prop?.description ?? ''}>
                                    {m.prop?.description || t('episode.asset.noDescription')}
                                  </div>
                                </>
                              )}
                              <div className={cn(ASSET_META, ASSET_FINAL, !m.finalPrompt && 'text-content-subtle')} title={m.finalPrompt}>
                                <span className={`${AFP_LABEL} mr-1`}>
                                  {g.kindKey === 'scene' ? t('episode.asset.finalPromptFixed') : t('episode.asset.finalPromptWhiteBg')}
                                </span>
                                {m.finalPrompt || (g.kindKey === 'scene' ? t('episode.asset.finalPromptAutoFixed') : t('episode.asset.finalPromptAutoWhiteBg'))}
                              </div>
                            </div>
                            <div className={ASSET_FOOT}>
                              <span className={cn(DOT, m.image && 'bg-success', isPending(m) && 'bg-brand')} />
                              <button
                                className={cn(buttonVariants({ size: 'sm' }), 'ml-auto')}
                                type="button"
                                title={t('episode.asset.uploadImage')}
                                disabled={isUploading(m)}
                                onClick={(e) => { e.stopPropagation(); uploadMaterial(m) }}
                              >
                                {isUploading(m) ? (
                                  <RingSpinner size="sm" />
                                ) : (
                                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                                )}
                                {t('episode.asset.upload')}
                              </button>
                              <button
                                className={buttonVariants({ size: 'sm' })}
                                type="button"
                                disabled={isPending(m)}
                                onClick={(e) => { e.stopPropagation(); void generateMaterial(m) }}
                              >
                                {isPending(m) && <RingSpinner size="sm" />}
                                {m.image ? t('episode.asset.regen') : isPending(m) ? t('episode.asset.generating') : t('episode.asset.generate')}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null,
              )}

              {/* 筛选某一类但该类暂无素材 */}
              {assetTab !== 'all' && !visibleAssets.length && (
                <div className={EMPTY_STATE}>
                  <div className={EMPTY_ICON}>
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
                    </svg>
                  </div>
                  <p className={EMPTY_TITLE}>{t('detail.assets.emptyKindTitle', { kind: tabLabel(assetTab) })}</p>
                  <p className={EMPTY_DESC}>{t('detail.assets.emptyKindDesc', { kind: tabLabel(assetTab) })}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 素材详情 / 编辑对话框（与工作台资产卡片同款布局） */}
      <Modal
        open={editDialogOpen && !!editTarget}
        onOpenChange={(v) => {
          if (!v) {
            setEditDialogOpen(false)
            setEditTarget(null)
          }
        }}
        width={860}
        title={
          editTarget ? (
            <span className={MAT_DETAIL_TITLE_BLOCK}>
              <span className={MAT_DETAIL_KICKER}>
                {editTarget.kindKey === 'character' ? t('episode.asset.typeChar') : editTarget.kindKey === 'scene' ? t('episode.asset.typeScene') : t('episode.asset.typeProp')}
              </span>
              <span className={MAT_DETAIL_TITLE}>{editTarget.name || t('detail.mat.unnamed')}</span>
            </span>
          ) : null
        }
        showClose={false}
        footer={
          <div className="flex min-w-0 w-full flex-wrap items-center justify-between gap-2">
            <div className={MAT_DETAIL_SECONDARY_ACTIONS}>
              <button
                type="button"
                className={buttonVariants({})}
                onClick={() => {
                  setEditDialogOpen(false)
                  setEditTarget(null)
                }}
              >
                {t('common.close')}
              </button>
            </div>
            <div className={MAT_DETAIL_PRIMARY_ACTIONS}>
              <button type="button" className={buttonVariants({})} disabled={!!editTarget && isUploading(editTarget)} onClick={() => editTarget && uploadMaterial(editTarget)}>
                {!!editTarget && isUploading(editTarget) ? (
                  <RingSpinner size="sm" />
                ) : (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                )}
                {t('episode.asset.uploadImage')}
              </button>
              <button type="button" className={buttonVariants({})} disabled={!!editTarget && isPending(editTarget)} onClick={() => editTarget && void generateMaterial(editTarget)}>
                {editTarget && editTarget.image
                  ? t('episode.sb.regenPrompt')
                  : editTarget && isPending(editTarget)
                    ? `${t('episode.asset.generating')}…`
                    : t('detail.mat.genImage')}
              </button>
              <button type="button" className={buttonVariants({ variant: 'primary' })} disabled={editSaving} onClick={() => void saveEdit()}>
                {editSaving ? t('detail.mat.saving') : t('episode.asset.saveChanges')}
              </button>
            </div>
          </div>
        }
      >
        {editTarget && (
          <div className={MAT_DETAIL_SHELL}>
            {/* 左侧：视觉预览 */}
            <aside className={MAT_DETAIL_PREVIEW_PANEL}>
              <div className={MAT_DETAIL_SECTION_TITLE}>
                <span>{t('episode.asset.visualPreview')}</span>
                <span className={cn(MAT_DETAIL_STATE, editTarget.image && MAT_DETAIL_STATE_READY)}>
                  {editTarget.image ? t('episode.asset.ready') : t('episode.asset.todo')}
                </span>
              </div>
              <button
                type="button"
                className={MAT_DETAIL_MEDIA_FRAME}
                aria-label={t('episode.viewer.imagePreview')}
                disabled={!editTarget.image}
                onClick={() => setViewer({ open: true, src: assetSrcOf(editTarget.image), title: `${editTarget.kind} · ${editTarget.name}` })}
              >
                {editTarget.image ? (
                  <img src={thumbOf(assetSrcOf(editTarget.image))} onError={(e) => thumbFallback(e, assetSrcOf(editTarget.image))} alt="" className="w-full h-full block object-cover" />
                ) : (
                  <span className={MAT_DETAIL_MEDIA_EMPTY}>
                    {editTarget.kindKey === 'character' && (
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                    )}
                    {editTarget.kindKey === 'prop' && (
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></svg>
                    )}
                    {editTarget.kindKey === 'scene' && (
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" /></svg>
                    )}
                  </span>
                )}
              </button>
              <div className={MAT_DETAIL_META_ROW}>
                <div className={MAT_DETAIL_META_ITEM}>
                  <span className={META_ITEM_LABEL}>{t('episode.asset.kindLabel')}</span>
                  <strong className={META_ITEM_VALUE}>
                    {editTarget.kindKey === 'character' ? t('episode.asset.charPortrait') : editTarget.kindKey === 'prop' ? t('common.prop') : t('episode.asset.sceneImage')}
                  </strong>
                </div>
                <div className={MAT_DETAIL_META_ITEM}>
                  <span className={META_ITEM_LABEL}>
                    {editTarget.kindKey === 'character' ? t('episode.asset.roleLabel') : editTarget.kindKey === 'prop' ? t('episode.asset.propTypeLabel') : t('episode.asset.timeLabel')}
                  </span>
                  <strong className={META_ITEM_VALUE}>
                    {editTarget.kindKey === 'character'
                      ? editTarget.character?.role || t('common.role')
                      : editTarget.kindKey === 'prop'
                        ? editTarget.prop?.type || t('common.prop')
                        : editTarget.scene?.time || t('episode.asset.noTime')}
                  </strong>
                </div>
              </div>
            </aside>

            {/* 右侧：编辑信息 */}
            <section className={MAT_DETAIL_EDITOR_PANEL}>
              <div className={MAT_DETAIL_SECTION_TITLE}>
                <span>{t('episode.asset.editInfo')}</span>
                <span className={cn('text-content-subtle', SECTION_TITLE_DIM)}>
                  {editTarget.kindKey === 'character' ? t('episode.asset.editHintChar') : editTarget.kindKey === 'prop' ? t('episode.asset.editHintProp') : t('episode.asset.editHintScene')}
                </span>
              </div>

              {editTarget.kindKey === 'prop' && (
                <div>
                  <label className={MAT_DETAIL_EDIT_FIELD}>
                    <span className={EDIT_FIELD_LABEL}>{t('episode.create.name')}</span>
                    <Input value={editDraft.name ?? ''} onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))} className={EDIT_FIELD_INPUT} placeholder={t('episode.create.namePlaceholderProp')} />
                  </label>
                  <label className={MAT_DETAIL_EDIT_FIELD}>
                    <span className={EDIT_FIELD_LABEL}>{t('episode.create.typeField')}</span>
                    <Input value={editDraft.type ?? ''} onChange={(e) => setEditDraft((d) => ({ ...d, type: e.target.value }))} className={EDIT_FIELD_INPUT} placeholder={t('detail.mat.propTypePlaceholder')} />
                  </label>
                  <label className={MAT_DETAIL_EDIT_FIELD}>
                    <span className={EDIT_FIELD_LABEL}>{t('episode.asset.appearanceOfObject')}</span>
                    <Textarea value={editDraft.description ?? ''} onChange={(e) => setEditDraft((d) => ({ ...d, description: e.target.value }))} className="mat-detail-textarea" rows={6} placeholder={t('episode.asset.appearancePlaceholder')} />
                  </label>
                </div>
              )}

              {editTarget.kindKey === 'character' && (
                <div>
                  <label className={MAT_DETAIL_EDIT_FIELD}>
                    <span className={EDIT_FIELD_LABEL}>{t('episode.create.name')}</span>
                    <Input value={editDraft.name ?? ''} onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))} className={EDIT_FIELD_INPUT} placeholder={t('episode.create.namePlaceholderChar')} />
                  </label>
                  <label className={MAT_DETAIL_EDIT_FIELD}>
                    <span className={EDIT_FIELD_LABEL}>{t('episode.create.roleField')}</span>
                    <Input value={editDraft.role ?? ''} onChange={(e) => setEditDraft((d) => ({ ...d, role: e.target.value }))} className={EDIT_FIELD_INPUT} placeholder={t('episode.create.rolePlaceholder')} />
                  </label>
                  <label className={MAT_DETAIL_EDIT_FIELD}>
                    <span className={EDIT_FIELD_LABEL}>{t('episode.asset.appearanceField')}</span>
                    <Textarea value={editDraft.appearance ?? ''} onChange={(e) => setEditDraft((d) => ({ ...d, appearance: e.target.value }))} className="mat-detail-textarea" rows={5} placeholder={t('episode.asset.appearanceFieldPlaceholder')} />
                  </label>
                  <label className={MAT_DETAIL_EDIT_FIELD}>
                    <span className={EDIT_FIELD_LABEL}>{t('episode.asset.stylingField')}</span>
                    <Textarea value={editDraft.styling ?? ''} onChange={(e) => setEditDraft((d) => ({ ...d, styling: e.target.value }))} className="mat-detail-textarea" rows={5} placeholder={t('episode.asset.stylingFieldPlaceholder')} />
                  </label>
                  <label className={MAT_DETAIL_EDIT_FIELD}>
                    <span className={EDIT_FIELD_LABEL}>{t('detail.mat.personaField')}</span>
                    <Textarea value={editDraft.description ?? ''} onChange={(e) => setEditDraft((d) => ({ ...d, description: e.target.value }))} className="mat-detail-textarea" rows={4} placeholder={t('detail.mat.personaPlaceholder')} />
                  </label>
                </div>
              )}

              {editTarget.kindKey === 'scene' && (
                <div>
                  <label className={MAT_DETAIL_EDIT_FIELD}>
                    <span className={EDIT_FIELD_LABEL}>{t('episode.create.location')}</span>
                    <Input value={editDraft.location ?? ''} onChange={(e) => setEditDraft((d) => ({ ...d, location: e.target.value }))} className={EDIT_FIELD_INPUT} placeholder={t('detail.mat.locationPlaceholder')} />
                  </label>
                  <label className={MAT_DETAIL_EDIT_FIELD}>
                    <span className={EDIT_FIELD_LABEL}>{t('episode.create.time')}</span>
                    <Input value={editDraft.time ?? ''} onChange={(e) => setEditDraft((d) => ({ ...d, time: e.target.value }))} className={EDIT_FIELD_INPUT} placeholder={t('detail.mat.timePlaceholder')} />
                  </label>
                  <label className={MAT_DETAIL_EDIT_FIELD}>
                    <span className={EDIT_FIELD_LABEL}>{t('episode.asset.sceneDescField')}</span>
                    <Textarea value={editDraft.prompt ?? ''} onChange={(e) => setEditDraft((d) => ({ ...d, prompt: e.target.value }))} className="mat-detail-textarea" rows={5} placeholder={t('episode.asset.sceneDescPlaceholder')} />
                  </label>
                  <label className={MAT_DETAIL_EDIT_FIELD}>
                    <span className={EDIT_FIELD_LABEL}>{t('episode.asset.sceneLightField')}</span>
                    <Textarea value={editDraft.lighting ?? ''} onChange={(e) => setEditDraft((d) => ({ ...d, lighting: e.target.value }))} className="mat-detail-textarea" rows={5} placeholder={t('episode.asset.sceneLightPlaceholder')} />
                  </label>
                </div>
              )}
            </section>
          </div>
        )}

        {editTarget && (
          /* 最终提示词：可生成 / 重新生成 / 手动编辑 */
          <section className={MAT_DETAIL_PROMPT_PANEL}>
            <div className={MAT_DETAIL_SECTION_TITLE}>
              <span>{t('detail.mat.finalPromptLabel')}</span>
              <span className={cn('text-content-subtle', SECTION_TITLE_DIM)}>{t('detail.mat.finalPromptSub')}</span>
              <button
                type="button"
                className={cn(buttonVariants({ size: 'sm' }), MAT_DETAIL_PROMPT_GEN)}
                disabled={finalPromptGen || !firstEpisodeId}
                title={firstEpisodeId ? t('detail.mat.genPromptTitle') : t('detail.mat.needEpisodeFirst')}
                onClick={() => void generateFinalPrompt(editTarget)}
              >
                {!finalPromptGen && (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v3m0 12v3m9-9h-3M6 12H3m13.5-6.5L14 8m-4 8-2.5 2.5m11 0L16 16M8 8 5.5 5.5" /><circle cx="12" cy="12" r="3" /></svg>
                )}
                {finalPromptGen
                  ? `${t('episode.asset.generating')}…`
                  : editDraft.finalPrompt
                    ? t('episode.sb.regenPrompt')
                    : t('episode.asset.genPrompt')}
              </button>
            </div>
            <Textarea
              value={editDraft.finalPrompt ?? ''}
              onChange={(e) => setEditDraft((d) => ({ ...d, finalPrompt: e.target.value }))}
              className="mat-detail-prompt-text"
              rows={5}
              placeholder={t('detail.mat.promptPlaceholder')}
            />
          </section>
        )}
      </Modal>

      {/* 图片查看器 */}
      <ImageViewer
        open={viewer.open}
        src={viewer.src}
        title={viewer.title}
        onClose={() => setViewer({ open: false, src: '', title: '' })}
      />

      {/* 新建集对话框 */}
      <Modal
        open={addDialog}
        onOpenChange={(v) => !v && setAddDialog(false)}
        width={460}
        title={t('detail.epCreate.title')}
        footer={
          <>
            <span className={DIALOG_FOOT_COPY}>{t('detail.epCreate.lockCopy')}</span>
            <button type="button" className={buttonVariants({})} onClick={() => setAddDialog(false)}>{t('common.cancel')}</button>
            <button type="button" className={buttonVariants({ variant: 'primary' })} disabled={addEpisodeMutation.isPending} onClick={() => addEpisodeMutation.mutate()}>
              {addEpisodeMutation.isPending ? t('detail.epCreate.creating') : t('detail.epCreate.create')}
            </button>
          </>
        }
      >
        <div>
          <label className={FIELD}>
            <span className={FIELD_LABEL}>{t('detail.epCreate.titleField')}</span>
            <Input
              value={newEpisodeTitle}
              onChange={(e) => setNewEpisodeTitle(e.target.value)}
              placeholder={t('detail.epCreate.titlePlaceholder')}
              autoFocus
            />
            <span className={FIELD_HINT}>
              {t('detail.epCreate.titleHint', { example: t('detail.epCreate.example', { n: 3 }) })}
            </span>
          </label>
          <label className={FIELD}>
            <span className={FIELD_LABEL}>{t('detail.epCreate.resolution')}</span>
            <BaseSelect value={newEpisodeResolution} onChange={setNewEpisodeResolution} options={resolutionOptions} placeholder={t('detail.epCreate.resolutionPlaceholder')} />
            <span className={FIELD_HINT}>{t('detail.epCreate.resolutionHint')}</span>
          </label>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!episodeToDelete}
        title={t('detail.ep.deleteTitle')}
        message={t('detail.epDelete.message', {
          title: episodeToDelete?.title || t('detail.ep.episodeN', { n: episodeToDelete?.episodeNumber }),
        })}
        loading={deleteEpisodeMutation.isPending}
        onConfirm={() => episodeToDelete && deleteEpisodeMutation.mutate(episodeToDelete.id)}
        onCancel={() => setEpisodeToDelete(null)}
      />
    </div>
  )
}
