import { useCreativeCatalog, useCatalogText } from '@/entities/creative/catalog'
/**
 * 项目启动台：列表、筛选、排序、创建、删除、手动状态标记。
 * 服务端数据经 React Query；状态标记为乐观更新（失败回滚）。
 * 样式已迁移 Tailwind（ProjectsPage.module.css 已删除）；
 * `.head-actions` 与 data-tour 属性保留为引导锚点。
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleHelp, Clock } from 'lucide-react'
import { dramaQueries } from '@/entities/drama/queries'
import { dramaApi } from '@/entities/drama/api'
import { qk } from '@/shared/api/query-keys'
import { stylePresetApi, type StylePreset } from '@/entities/settings/api'
import { projectPath, type Drama, type ProjectType } from '@/entities/drama/model'
import { toastError } from '@/shared/lib/errors'
import { relativeTime } from '@/shared/lib/format'
import { autoTour, startTour, type TourStep } from '@/shared/lib/tour'
import { BaseSelect } from '@/shared/ui/BaseSelect'
import { AppMenu } from '@/shared/ui/AppMenu'
import { AppMenuItem } from '@/shared/ui/AppMenuItem'
import { ConfirmDialog } from '@/shared/ui/ConfirmDialog'
import { Button, IconButton } from '@/shared/ui/button'
import { Badge } from '@/shared/ui/badge'
import { cardVariants } from '@/shared/ui/card'
import { Input } from '@/shared/ui/input'
import { cn } from '@/shared/lib/cn'
import { CreateProjectDialog } from './CreateProjectDialog'

const INDEX_TOUR: TourStep[] = [
  { element: '#root', titleKey: 'tour.index.welcome.title', descKey: 'tour.index.welcome.desc' },
  { element: '.nav-link[href="/settings"]', titleKey: 'tour.index.settings.title', descKey: 'tour.index.settings.desc', popoverSide: 'bottom' },
  { element: '[data-tour="create-project"]', titleKey: 'tour.index.create.title', descKey: 'tour.index.create.desc', popoverSide: 'bottom', popoverAlign: 'end' },
]

const filterChipClass =
  'cursor-pointer rounded-pill border-none bg-track px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap ' +
  'text-content-muted transition-all duration-150 ease-app hover:bg-active-overlay hover:text-content ' +
  'focus-visible:outline-none focus-visible:shadow-focus'

export function ProjectsPage() {
  const { t } = useTranslation()
  const catalog = useCreativeCatalog()
  const localize = useCatalogText()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // 渲染时求值（依赖 i18n 语言），语言切换即时生效
  const statusOptions = useMemo(
    () => [
      { label: t('index.status.draft'), value: 'draft' },
      { label: t('index.status.active'), value: 'active' },
      { label: t('index.status.completed'), value: 'completed' },
    ],
    [t],
  )

  const dramasQuery = useQuery(dramaQueries.list())
  const presetsQuery = useQuery({
    queryKey: qk.stylePresets(false),
    queryFn: ({ signal }) => stylePresetApi.list(false, signal),
    staleTime: 60_000,
  })
  const dramas = dramasQuery.data?.items ?? []
  const stylePresets: StylePreset[] = useMemo(() => presetsQuery.data ?? [], [presetsQuery.data])

  const [showCreate, setShowCreate] = useState(false)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [projectTypeFilter, setProjectTypeFilter] = useState<'all' | ProjectType>('all')
  const [sortMode, setSortMode] = useState('updated')
  const [statusMenuId, setStatusMenuId] = useState<number | null>(null)
  const [activeMenuId, setActiveMenuId] = useState<number | null>(null)
  const [dramaToDelete, setDramaToDelete] = useState<Drama | null>(null)

  const sortOptions = useMemo(
    () => [
      { label: t('index.sortUpdated'), value: 'updated' },
      { label: t('index.sortTitle'), value: 'title' },
    ],
    [t],
  )
  const aspectRatioOptions = useMemo(
    () => [
      { label: t('index.ratio.landscape'), value: '16:9' },
      { label: t('index.ratio.portrait'), value: '9:16' },
      { label: t('index.ratio.square'), value: '1:1' },
      { label: t('index.ratio.adaptive'), value: 'adaptive' },
    ],
    [t],
  )
  const filters = useMemo(
    () => [
      { label: t('index.status.all'), value: 'all' },
      { label: t('index.status.draft'), value: 'draft' },
      { label: t('index.status.active'), value: 'active' },
      { label: t('index.status.completed'), value: 'completed' },
    ],
    [t],
  )

  // 状态标记：乐观更新 + 失败回滚（小字段，确有体验收益）
  const setStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) => dramaApi.update(id, { status }),
    onMutate: async ({ id, status }) => {
      await queryClient.cancelQueries({ queryKey: qk.dramas() })
      const snapshots = queryClient.getQueriesData<{ items: Drama[]; total: number }>({ queryKey: qk.dramas() })
      queryClient.setQueriesData<{ items: Drama[]; total: number }>({ queryKey: qk.dramas() }, (data) =>
        data ? { ...data, items: data.items.map((d) => (d.id === id ? { ...d, status } : d)) } : data,
      )
      return { snapshots }
    },
    onError: (err, _vars, ctx) => {
      ctx?.snapshots.forEach(([key, data]) => queryClient.setQueryData(key, data))
      toastError(err)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.dramas() }),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => dramaApi.del(id),
    onSuccess: (_data, id) => {
      toast.success(t('index.deleted'))
      setDramaToDelete(null)
      // 删除后移除该项目缓存与作用域，再刷新列表
      queryClient.removeQueries({ queryKey: ['workspace', 'default', 'dramas', id] })
      void queryClient.invalidateQueries({ queryKey: qk.dramas() })
    },
    onError: (err) => toastError(err),
  })

  function styleLabel(key: string): string {
    return stylePresets.find((p) => p.value === key)?.name || key || ''
  }

  function currentStatus(d: Drama): string {
    return d.status || 'draft'
  }

  const filteredDramas = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase()
    const items = dramas.filter((d) => {
      const statusLabel = statusOptions.find((s) => s.value === currentStatus(d))?.label ?? ''
      const text = [d.title, d.style, styleLabel(d.style), statusLabel].filter(Boolean).join(' ').toLowerCase()
      const matchesSearch = !keyword || text.includes(keyword)
      const matchesStatus = statusFilter === 'all' || currentStatus(d) === statusFilter
      return matchesSearch && matchesStatus && (projectTypeFilter === 'all' || d.projectType === projectTypeFilter)
    })
    return [...items].sort((a, b) => {
      if (sortMode === 'title') return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN')
      return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
    })
    // styleLabel 依赖 stylePresets（随查询数据更新）
     
  }, [dramas, searchKeyword, statusFilter, projectTypeFilter, sortMode, stylePresets, statusOptions])

  useEffect(() => {
    const timer = setTimeout(() => autoTour('index', INDEX_TOUR), 600)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-app px-7 pt-5 pb-12 max-760:px-4 max-760:pt-4 max-760:pb-10 animate-fade-up">
      {/* 紧凑头部：标题 + 统计 + 新建 一行 */}
      <div className="flex items-center gap-4 pb-4 max-760:flex-wrap">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-xl font-[650] tracking-[-0.02em] whitespace-nowrap text-content">{t('index.hero.title')}</h1>
          <span className="overflow-hidden text-[12.5px] text-ellipsis whitespace-nowrap text-content-subtle max-760:hidden">
            {t('index.hero.sub')}
          </span>
        </div>
        <div className="ml-auto flex gap-2 max-760:hidden">
          <Badge>{t('index.hero.projectCount', { n: dramas.length })}</Badge>
          <Badge tone="success">
            {t('index.hero.activeCount', { n: dramas.filter((d) => currentStatus(d) === 'active').length })}
          </Badge>
          <Badge tone="brand">{t('index.hero.styleCount', { n: stylePresets.length })}</Badge>
        </div>
        <div className="head-actions flex shrink-0 items-center gap-2">
          <IconButton variant="ghost" size="icon" className="tour-help-btn size-9" title={t('tour.helpTitle')} onClick={() => startTour('index', INDEX_TOUR)}>
            <CircleHelp size={15} strokeWidth={1.8} />
          </IconButton>
          <Button variant="primary" data-tour="create-project" onClick={() => setShowCreate(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {t('index.create')}
          </Button>
        </div>
      </div>

      <div className="mb-4 flex gap-2" role="group" aria-label={t('index.createDialog.projectType')}>
        {(['all', 'drama', 'creative'] as const).map(type => (
          <button key={type} type="button" aria-pressed={projectTypeFilter === type}
            className={cn(filterChipClass, projectTypeFilter === type && 'bg-brand-soft text-brand-content')}
            onClick={() => setProjectTypeFilter(type)}>
            {t(type === 'all' ? 'index.allProjects' : `index.createDialog.${type}Title`)}
          </button>
        ))}
      </div>
      <div className="mb-4 flex items-center gap-3 max-760:flex-wrap">
        <label className="relative w-60 shrink-0 max-760:w-full max-760:flex-1">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-content-subtle"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <Input
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value.trim())}
            className="rounded-pill border-outline bg-hover-overlay pl-[34px] focus:bg-input"
            placeholder={t('index.searchPlaceholder')}
          />
        </label>
        <div className="flex gap-1.5 overflow-x-auto pb-px">
          {filters.map((f) => (
            <button
              key={f.value}
              type="button"
              className={cn(filterChipClass, statusFilter === f.value && 'bg-inverse text-on-inverse')}
              onClick={() => setStatusFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="ml-auto w-[132px] shrink-0 max-760:ml-0 max-760:flex-1">
          <BaseSelect value={sortMode} onChange={setSortMode} options={sortOptions} searchable={false} />
        </div>
      </div>

      {/* 加载骨架 */}
      {dramasQuery.isPending ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4 max-900:grid-cols-[repeat(auto-fill,minmax(200px,1fr))] max-900:gap-3 max-760:grid-cols-[repeat(auto-fill,minmax(160px,1fr))]">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className={cn(cardVariants(), 'overflow-hidden')}>
              <div className="aspect-[2.1/1] animate-skeleton-pulse bg-elevated" />
              <div className="grid gap-2.5 px-3.5 pt-3 pb-3.5">
                <div className="w-[60%] h-3 animate-skeleton-pulse rounded-full bg-elevated" />
                <div className="w-[40%] h-3 animate-skeleton-pulse rounded-full bg-elevated" />
              </div>
            </div>
          ))}
        </div>
      ) : filteredDramas.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4 max-900:grid-cols-[repeat(auto-fill,minmax(200px,1fr))] max-900:gap-3 max-760:grid-cols-[repeat(auto-fill,minmax(160px,1fr))]">
          {filteredDramas.map((d, i) => (
            <article
              key={d.id}
              className={cn(
                cardVariants(),
                'group relative cursor-pointer overflow-hidden animate-fade-up hover:border-outline-strong focus-visible:border-brand focus-visible:outline-none focus-visible:shadow-focus',
              )}
              style={{ animationDelay: `${i * 0.04}s` }}
              tabIndex={0}
              role="button"
              aria-label={t('index.openProjectAria', { title: d.title })}
              onClick={() => navigate(projectPath(d))}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  navigate(projectPath(d))
                }
              }}
            >
              <div className="relative flex aspect-[2.1/1] items-center justify-center border-b border-outline bg-[linear-gradient(135deg,var(--hb-brand-soft)_0%,var(--hb-bg-1)_70%)]">
                <span className="text-[30px] font-bold text-brand-content opacity-55 select-none">
                  {String(d.title || '?').trim().slice(0, 1).toUpperCase() || '?'}
                </span>
                {d.aspectRatio && d.aspectRatio !== 'adaptive' && (
                  <span className="absolute right-2.5 bottom-2 rounded-[5px] border border-outline bg-surface px-[7px] py-0.5 font-code text-tiny font-medium tracking-[0.02em] text-content-subtle">
                    {d.aspectRatio}
                  </span>
                )}
                <div className="absolute top-2.5 left-2.5" onClick={(e) => e.stopPropagation()}>
                  <AppMenu
                    open={statusMenuId === d.id}
                    onOpenChange={(v) => setStatusMenuId(v ? d.id : null)}
                    placement="bottom-start"
                    minWidth={120}
                    trigger={() => (
                      <button
                        type="button"
                        className="inline-flex cursor-pointer items-center gap-1.5 rounded-pill border border-outline bg-surface px-2.5 py-1 text-micro font-medium whitespace-nowrap text-content-muted transition-colors duration-150 ease-app hover:bg-surface hover:text-content"
                        title={t('index.statusBadgeTitle')}
                      >
                        <span
                          className={cn(
                            'size-1.5 rounded-full',
                            currentStatus(d) === 'active' ? 'bg-success' : currentStatus(d) === 'completed' ? 'bg-brand' : 'bg-content-subtle',
                          )}
                        />
                        {statusOptions.find((s) => s.value === currentStatus(d))?.label ?? t('index.status.draft')}
                      </button>
                    )}
                  >
                    {statusOptions.map((s) => (
                      <AppMenuItem
                        key={s.value}
                        selected={currentStatus(d) === s.value}
                        onClick={() => {
                          setStatusMenuId(null)
                          if (currentStatus(d) !== s.value) setStatusMutation.mutate({ id: d.id, status: s.value })
                        }}
                      >
                        {s.label}
                      </AppMenuItem>
                    ))}
                  </AppMenu>
                </div>
                <div className="absolute top-2 right-2" onClick={(e) => e.stopPropagation()}>
                  <AppMenu
                    open={activeMenuId === d.id}
                    onOpenChange={(v) => setActiveMenuId(v ? d.id : null)}
                    placement="bottom-end"
                    minWidth={140}
                    trigger={() => (
                      <IconButton
                        size="icon"
                        className="size-[30px] min-w-[30px] min-h-[30px] border border-outline bg-surface text-content-muted opacity-0 transition-[opacity,color] duration-150 ease-app hover:text-content group-hover:opacity-100 group-focus-within:opacity-100"
                        title={t('common.more')}
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                          <circle cx="5" cy="12" r="1" />
                          <circle cx="12" cy="12" r="1" />
                          <circle cx="19" cy="12" r="1" />
                        </svg>
                      </IconButton>
                    )}
                  >
                    <AppMenuItem onClick={() => { setActiveMenuId(null); navigate(projectPath(d)) }}>
                      {t('index.openProject')}
                    </AppMenuItem>
                    <AppMenuItem danger onClick={() => { setActiveMenuId(null); setDramaToDelete(d) }}>
                      {t('index.deleteProject')}
                    </AppMenuItem>
                  </AppMenu>
                </div>
              </div>
              <div className="px-3.5 pt-3 pb-[13px]">
                <h2 className="truncate m-0 text-sm font-semibold tracking-[-0.01em] text-content">{d.title}</h2>
                <div className="mt-[7px] flex flex-wrap items-center gap-2 text-[11.5px]">
                  <Badge>{t(`index.createDialog.${d.projectType || 'drama'}Title`)}</Badge>
                  {d.style && <Badge tone="brand">{styleLabel(d.style)}</Badge>}
                  <span className="text-content-subtle">
                    {d.projectType === 'creative'
                      ? localize(catalog.data?.find(item => item.id === d.creativeCategory)?.title) || (['product', 'montage'].includes(d.creativeCategory ?? '') ? t(`index.createDialog.categories.${d.creativeCategory}.title`) : d.creativeCategory)
                      : t('index.projectMeta', { chars: d.characters.length, scenes: d.scenes.length, eps: d.episodes.length })}
                  </span>
                </div>
                <div className="text-content-subtle mt-2.5 flex items-center gap-1 text-micro whitespace-nowrap">
                  <Clock size={11} strokeWidth={1.8} />
                  {relativeTime(d.updatedAt)}
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="flex min-h-60 flex-1 flex-col items-center justify-center gap-2.5 rounded-panel border border-dashed border-outline-strong bg-surface text-center">
          <div className="mb-1 flex size-14 items-center justify-center rounded-panel bg-elevated text-content-subtle">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden>
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <line x1="12" y1="8" x2="12" y2="16" />
              <line x1="8" y1="12" x2="16" y2="12" />
            </svg>
          </div>
          <p className="text-sm font-semibold text-content-secondary">
            {dramas.length ? t('index.emptyFilteredTitle') : t('index.emptyTitle')}
          </p>
          <p className="max-w-60 text-xs leading-[1.6] text-content-subtle">
            {dramas.length ? t('index.emptyFilteredDesc') : t('index.emptyDesc')}
          </p>
          {!dramas.length && (
            <Button variant="primary" onClick={() => setShowCreate(true)}>
              {t('index.create')}
            </Button>
          )}
        </div>
      )}

      <CreateProjectDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        stylePresets={stylePresets}
        aspectRatioOptions={aspectRatioOptions}
        onCreated={(id, projectType) => navigate(projectPath({ id, projectType }))}
      />

      <ConfirmDialog
        open={!!dramaToDelete}
        title={t('index.deleteDialog.title')}
        message={t(dramaToDelete?.projectType === 'creative' ? 'index.deleteDialog.creativeMessage' : 'index.deleteDialog.message', { title: dramaToDelete?.title })}
        loading={deleteMutation.isPending}
        onConfirm={() => dramaToDelete && deleteMutation.mutate(dramaToDelete.id)}
        onCancel={() => setDramaToDelete(null)}
      />
    </div>
  )
}
