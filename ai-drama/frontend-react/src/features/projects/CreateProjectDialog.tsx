import { useCreativeCatalog, useCatalogText, useProductionText } from '@/entities/creative/catalog'
import { filmQueries } from '@/entities/film/model'
/** 新建项目弹窗：选择项目类型后进入对应的独立制作工作台。 */
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Check, Clapperboard, Film, Info, Layers, Package, Plus, Sparkles, type LucideIcon } from 'lucide-react'
import { toastError } from '@/shared/lib/errors'
import { cn } from '@/shared/lib/cn'
import { dramaApi } from '@/entities/drama/api'
import type { ProjectType, CreativeCategory } from '@/entities/drama/model'
import { qk } from '@/shared/api/query-keys'
import { Modal } from '@/shared/ui/Modal'
import { BaseSelect } from '@/shared/ui/BaseSelect'
import type { SelectOption } from '@/shared/ui/BaseSelect'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import type { StylePreset } from '@/entities/settings/api'

interface CreateProjectDialogProps {
  open: boolean
  onClose: () => void
  stylePresets: StylePreset[]
  aspectRatioOptions: SelectOption[]
  onCreated: (projectId: number, projectType: ProjectType) => void
}

const fieldClass = 'flex flex-col gap-1.5'
const fieldLabelClass = 'text-xs font-semibold text-content-secondary'

function ProjectChoice({ name, value, title, description, icon: Icon, checked, disabled, onChange }: {
  name: string
  value: string
  title: string
  description: string
  icon: LucideIcon
  checked: boolean
  disabled: boolean
  onChange: () => void
}) {
  const descriptionId = useId()

  return (
    <label className="relative min-w-0 cursor-pointer">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        aria-label={title}
        aria-describedby={descriptionId}
        className="peer sr-only"
      />
      <span className={cn(
        'flex h-full items-start gap-3 rounded-control border border-solid p-3.5 text-left transition-colors duration-150 motion-reduce:transition-none',
        'peer-focus-visible:outline-none peer-focus-visible:shadow-focus peer-disabled:cursor-not-allowed peer-disabled:opacity-45',
        checked ? 'border-brand bg-brand-soft' : 'border-outline-strong bg-surface hover:border-outline-hover hover:bg-hover-overlay',
      )}>
        <Icon size={19} strokeWidth={1.7} className={cn('mt-0.5 shrink-0', checked ? 'text-brand' : 'text-content-muted')} aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-sm font-semibold text-content">{title}</span>
          <span id={descriptionId} className="text-xs leading-[1.6] text-content-muted">{description}</span>
        </span>
        <span className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-solid',
          checked ? 'border-brand bg-brand text-on-action' : 'border-outline-strong',
        )} aria-hidden>
          {checked && <Check size={11} strokeWidth={3} />}
        </span>
      </span>
    </label>
  )
}

export function CreateProjectDialog({ open, onClose, stylePresets, aspectRatioOptions, onCreated }: CreateProjectDialogProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const catalog = useCreativeCatalog(open)
  const localize = useCatalogText()
  const words = useProductionText()
  const [categoryGroup, setCategoryGroup] = useState('all')
  const [categorySearch, setCategorySearch] = useState('')
  const [projectType, setProjectType] = useState<ProjectType>('drama')
  const [creativeCategory, setCreativeCategory] = useState<CreativeCategory | 'film'>('explainer')
  const [filmStyle, setFilmStyle] = useState('ink-wash')
  const filmGroups = useQuery(filmQueries.groups())
  const [title, setTitle] = useState('')
  const [style, setStyle] = useState('')
  const [aspectRatio, setAspectRatio] = useState('16:9')

  const styleSelectOptions = stylePresets.map((p) => ({ label: p.name, value: p.value }))
  const selectedStyleDesc = stylePresets.find((p) => p.value === style)?.description || ''
  const availableRatios = projectType === 'creative'
    ? aspectRatioOptions.filter((option) => option.value !== 'adaptive')
    : aspectRatioOptions

  const filmFlat = (filmGroups.data ?? []).flatMap((g) => g.styles)
  const isFilmGroup = categoryGroup === 'film'
  const filteredFilmStyles = isFilmGroup
    ? filmFlat.filter((st) => `${st.cn} ${st.en} ${st.category_cn} ${st.line_cn}`.toLowerCase().includes(categorySearch.trim().toLowerCase()))
    : []
  const filteredCategories = isFilmGroup
    ? []
    : catalog.data?.filter(item => (categoryGroup === 'all' || item.group === categoryGroup) && `${localize(item.title)} ${localize(item.description)}`.toLowerCase().includes(categorySearch.trim().toLowerCase())) ?? []
  const totalChoices = (catalog.data?.length ?? 0) + filmFlat.length

  // 只在重新打开时重置，后台预设刷新不能清空正在编辑的草稿。
  useEffect(() => {
    if (!open) return
    setProjectType('drama')
    setCategoryGroup('all')
    setCategorySearch('')
    setCreativeCategory('explainer')
    setTitle('')
    setStyle('')
    setAspectRatio('16:9')
  }, [open])

  useEffect(() => {
    if (!open) return
    setStyle((current) => current || stylePresets[0]?.value || '')
  }, [open, stylePresets])

  const createMutation = useMutation({
    mutationFn: () =>
      dramaApi.create({
        title: title.trim(),
        style: style || undefined,
        aspect_ratio: aspectRatio,
        ...(projectType === 'creative'
          ? creativeCategory === 'film'
            ? { project_type: 'film' as const, film_style: filmStyle, topic: '', language: 'zh', duration_sec: 45, has_voice: true }
            : { project_type: 'creative' as const, creative_category: creativeCategory }
          : {}),
      }),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: qk.dramas() })
      onClose()
      onCreated(Number((data as { id?: number })?.id), creativeCategory === 'film' ? 'film' : projectType)
    },
    onError: (err) => toastError(err),
  })

  return (
    <Modal
      open={open}
      onOpenChange={(v) => !v && !createMutation.isPending && onClose()}
      width={projectType === 'creative' ? 800 : 640}
      description={t('index.createDialog.desc')}
      title={
        <span className="flex flex-col gap-0.5">
          <span>{t('index.createDialog.title')}</span>
          <span className="text-[12.5px] font-normal text-content-subtle">{t('index.createDialog.desc')}</span>
        </span>
      }
      showClose={false}
      icon={
        <div className="flex size-10 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand">
          <Plus size={19} strokeWidth={1.8} aria-hidden />
        </div>
      }
      footer={
        <>
          <Button onClick={onClose} disabled={createMutation.isPending} className="shrink-0">{t('common.cancel')}</Button>
          <Button
            type="submit"
            form="create-project-form"
            variant="primary"
            loading={createMutation.isPending}
            disabled={projectType === 'creative' && creativeCategory !== 'film' && !catalog.data?.some(item => item.id === creativeCategory)}
            className="min-w-0 whitespace-normal text-center leading-[1.35]"
          >
            <Plus size={13} strokeWidth={2.2} className="shrink-0" aria-hidden />
            {t('index.createDialog.submit')}
          </Button>
        </>
      }
    >
      <form
        id="create-project-form"
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (createMutation.isPending || !title.trim() || (projectType === 'creative' && creativeCategory !== 'film' && !catalog.data?.some(item => item.id === creativeCategory))) return
          createMutation.mutate()
        }}
      >
        <fieldset className="min-w-0 border-0" disabled={createMutation.isPending}>
          <legend className={cn(fieldLabelClass, 'mb-2')}>{t('index.createDialog.projectType')}</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ProjectChoice
              name="project-type"
              value="drama"
              title={t('index.createDialog.dramaTitle')}
              description={t('index.createDialog.dramaDescription')}
              icon={Film}
              checked={projectType === 'drama'}
              disabled={createMutation.isPending}
              onChange={() => setProjectType('drama')}
            />
            <ProjectChoice
              name="project-type"
              value="creative"
              title={t('index.createDialog.creativeTitle')}
              description={t('index.createDialog.creativeDescription')}
              icon={Sparkles}
              checked={projectType === 'creative'}
              disabled={createMutation.isPending}
              onChange={() => {
                setProjectType('creative')
                if (aspectRatio === 'adaptive') setAspectRatio('16:9')
              }}
            />
          </div>
        </fieldset>
        {projectType === 'creative' && (
          <fieldset className="min-w-0 border-0">
            <legend className={cn(fieldLabelClass, 'mb-2')}>{t('index.createDialog.creativeCategory')}</legend>
            <div className="mb-3 flex flex-wrap gap-2">
              {(['all', 'story', 'business', 'presenter', 'reuse', 'film'] as const).map(group => <Button key={group} size="sm" aria-pressed={categoryGroup === group} disabled={createMutation.isPending} variant={categoryGroup === group ? 'primary' : 'default'} onClick={() => setCategoryGroup(group)}>{({all:words('全部类型','All types'),story:words('故事与视觉','Story & visuals'),business:words('演示与教学','Demos & tutorials'),presenter:words('讲述与出镜','Presenters'),reuse:words('素材再创作','Repurpose'),film:words('影片风格 43','Film styles 43')})[group]}</Button>)}
            </div>
            <Input aria-label={words('搜索视频类型','Search video types')} placeholder={words('搜索类型、用途…','Search types and use cases…')} value={categorySearch} onChange={event => setCategorySearch(event.target.value)} disabled={createMutation.isPending} className="mb-3" />
            <p className="mb-3 text-xs text-content-muted">{words('已选择：','Selected: ')}{creativeCategory === 'film' ? `${filmFlat.find((st) => st.slug === filmStyle)?.cn ?? ''}（${words('影片风格','film style')}）` : localize(catalog.data?.find(item => item.id === creativeCategory)?.title)} · {totalChoices} {words('种可选风格','styles')}</p>
            {catalog.isPending && <p role="status">{words('正在加载视频类型…','Loading video types…')}</p>}
            {catalog.isError && <div role="alert">{words('无法加载类型，请重试','Could not load types. Retry.')}<Button onClick={() => void catalog.refetch()}>{words('重试','Retry')}</Button></div>}
            {catalog.data && !filteredCategories.length && !filteredFilmStyles.length && <p role="status" className="py-5 text-center text-sm text-content-muted">{words('没有匹配的类型，试试其他关键词或分类','No matching types. Try another search or group.')}</p>}
            {isFilmGroup && (
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {filteredFilmStyles.map((st) => (
                  <ProjectChoice
                    key={st.slug}
                    name="creative-category"
                    value="film"
                    title={`${st.cn} · ${st.en}`}
                    description={`${st.category_cn} ｜ ${st.renderProfile === '3d' ? '3D' : st.renderProfile === 'shader' ? 'Shader' : '2D'}${st.line_cn ? ` ｜ ${st.line_cn}` : ''}`}
                    icon={Film}
                    checked={creativeCategory === 'film' && filmStyle === st.slug}
                    disabled={createMutation.isPending}
                    onChange={() => { setCreativeCategory('film'); setFilmStyle(st.slug) }}
                  />
                ))}
              </div>
            )}
            {!isFilmGroup && (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {filteredCategories.map((item) => (

                <ProjectChoice
                  key={item.id}
                  name="creative-category"
                  value={item.id}
                  title={localize(item.title)}
                  description={localize(item.description)}
                  icon={item.group === 'business' ? Package : item.group === 'story' ? Clapperboard : item.group === 'presenter' ? BookOpen : Layers}
                  checked={creativeCategory === item.id}
                  disabled={createMutation.isPending}
                  onChange={() => setCreativeCategory(item.id)}
                />
              ))}
            </div>
            )}
          </fieldset>
        )}
        <label className={fieldClass}>
          <span className={fieldLabelClass}>
            {t('index.createDialog.name')} <span className="text-danger">*</span>
          </span>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t(projectType === 'drama' ? 'index.createDialog.namePlaceholder' : 'index.createDialog.creativeNamePlaceholder')}
            disabled={createMutation.isPending}
            required
            autoFocus
          />
        </label>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className={fieldClass}>
            <span className={fieldLabelClass}>{t('index.createDialog.style')}</span>
            <BaseSelect
              value={style}
              onChange={setStyle}
              options={styleSelectOptions}
              placeholder={t('index.createDialog.stylePlaceholder')}
              searchable
              disabled={createMutation.isPending}
            />
            {selectedStyleDesc && <span className="text-micro leading-[1.5] text-content-subtle">{selectedStyleDesc}</span>}
          </label>
          <label className={fieldClass}>
            <span className={fieldLabelClass}>{t('index.createDialog.aspectRatio')}</span>
            <BaseSelect
              value={aspectRatio}
              onChange={setAspectRatio}
              options={availableRatios}
              placeholder={t('index.createDialog.aspectRatioPlaceholder')}
              disabled={createMutation.isPending}
            />
            <span className="text-micro leading-[1.5] text-content-subtle">{t('index.createDialog.aspectRatioHint')}</span>
          </label>
        </div>
        {projectType === 'creative' && (
          <p id="creative-project-setup-hint" role="status" className="flex items-start gap-2 rounded-control bg-info-soft px-3 py-2.5 text-xs leading-[1.6] text-content-muted">
            <Info size={15} className="mt-0.5 shrink-0 text-info" aria-hidden />
            <span>{t('index.createDialog.creativeSetupHint')}</span>
          </p>
        )}
      </form>
    </Modal>
  )
}
