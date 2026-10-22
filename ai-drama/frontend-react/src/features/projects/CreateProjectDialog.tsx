import { useCreativeCatalog, useCatalogText, useProductionText } from '@/entities/creative/catalog'
/** 新建项目弹窗：选择项目类型后进入对应的独立制作工作台。 */
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Check, Clapperboard, Film, Info, Layers, Package, Plus, Sparkles, type LucideIcon } from 'lucide-react'
import { toastError } from '@/shared/lib/errors'
import { cn } from '@/shared/lib/cn'
import { dramaApi } from '@/entities/drama/api'
import { creativeApi } from '@/entities/creative/api'
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
  const [projectType, setProjectType] = useState<ProjectType>('drama')
  const [creativeCategory, setCreativeCategory] = useState<CreativeCategory>('explainer')
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [style, setStyle] = useState('')
  const [aspectRatio, setAspectRatio] = useState('16:9')

  const styleSelectOptions = stylePresets.map((p) => ({ label: p.name, value: p.value }))
  const selectedStyleDesc = stylePresets.find((p) => p.value === style)?.description || ''
  const availableRatios = aspectRatioOptions

  const filteredCategories = catalog.data ?? []

  // 只在重新打开时重置，后台预设刷新不能清空正在编辑的草稿。
  useEffect(() => {
    if (!open) return
    setProjectType('drama')
    setCreativeCategory('explainer')
    setSourceFile(null)
    setTitle('')
    setStyle('')
    setAspectRatio('16:9')
  }, [open])

  useEffect(() => {
    if (!open || projectType === 'creative') return
    setStyle((current) => current || stylePresets[0]?.value || '')
  }, [open, stylePresets, projectType])

  const createMutation = useMutation({
    mutationFn: async () => {
      const data = await dramaApi.create({
        title: title.trim(),
        style: style || undefined,
        aspect_ratio: aspectRatio,
        ...(projectType === 'creative'
          ? { project_type: 'creative' as const, creative_category: creativeCategory }
          : {}),
      })
      // OpenMontage Paste-A-Video 对齐：需原片的模式在创建时一并上传，
      // 流程的 research/assets 阶段即可直接取用
      const recipe = catalog.data?.find(item => item.id === creativeCategory)
      if (projectType === 'creative' && sourceFile && (recipe?.source === 'video' || recipe?.source === 'audio-video')) {
        const id = Number((data as { id?: number })?.id)
        await creativeApi.sourceUpload(id, 1, sourceFile)
      }
      return data
    },
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: qk.dramas() })
      onClose()
      onCreated(Number((data as { id?: number })?.id), projectType)
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
            disabled={projectType === 'creative' && !catalog.data?.some(item => item.id === creativeCategory)}
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
          if (createMutation.isPending || !title.trim() || (projectType === 'creative' && !catalog.data?.some(item => item.id === creativeCategory))) return
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
                // 短剧向的默认风格预选不带入制片；用户明确选过的保留
                setStyle(current => current && current === stylePresets[0]?.value ? '' : current)
              }}
            />
          </div>
        </fieldset>
        {projectType === 'creative' && (
          <fieldset className="min-w-0 border-0">
            <legend className={cn(fieldLabelClass, 'mb-2')}>{t('index.createDialog.creativeCategory')}</legend>
            <p className="mb-3 text-xs text-content-muted">{words('已选择：','Selected: ')}{localize(catalog.data?.find(item => item.id === creativeCategory)?.title)} · {catalog.data?.length ?? 0} {words('种制作模式','production modes')}</p>
            {catalog.isPending && <p role="status">{words('正在加载视频类型…','Loading video types…')}</p>}
            {catalog.isError && <div role="alert">{words('无法加载类型，请重试','Could not load types. Retry.')}<Button onClick={() => void catalog.refetch()}>{words('重试','Retry')}</Button></div>}
            {catalog.data && !filteredCategories.length && <p role="status" className="py-5 text-center text-sm text-content-muted">{words('没有匹配的制作模式，试试其他关键词','No matching modes. Try another search keyword.')}</p>}
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
        {projectType === 'creative' && (() => {
          const recipe = catalog.data?.find(item => item.id === creativeCategory)
          const needsSource = recipe?.source === 'video' || recipe?.source === 'audio-video'
          return needsSource ? (
          <label className={fieldClass}>
            <span className={fieldLabelClass}>{t('index.createDialog.sourceVideo')} <span className="text-danger">*</span></span>
            <input
              type="file"
              accept="video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,audio/mp4,.m4v,.m4a,.aac"
              disabled={createMutation.isPending}
              className="w-full rounded-control border border-outline bg-surface px-3 py-2 text-sm text-content file:mr-3 file:rounded-pill file:border-0 file:bg-brand-soft file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-brand-content"
              onChange={(e) => setSourceFile(e.target.files?.[0] ?? null)}
            />
            <span className="text-micro leading-[1.5] text-content-subtle">{t('index.createDialog.sourceHint')}</span>
          </label>
          ) : null
        })()}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {projectType === 'drama' && (
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
          )}
          {projectType === 'drama' && (
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
          )}
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
