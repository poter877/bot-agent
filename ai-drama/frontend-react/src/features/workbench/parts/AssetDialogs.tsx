/** 资产详情编辑弹窗（与项目详情页同款布局：左预览右表单 + 最终提示词生成/复制/保存）与新增资产弹窗 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { thumbOf, thumbFallback } from '@/shared/lib/media'
import { toastError } from '@/shared/lib/errors'
import { t as globalT } from '@/shared/config/i18n'
import { assetImageSrcOf, assetViewOf, type AssetView } from '../workbench-lib'
import type { AssetKind } from '@/entities/asset/model'
import { assetApiOf } from '@/entities/asset/api'
import { useWorkbench } from '../WorkbenchProvider'
import { useWorkbenchUi } from '../EpisodeWorkbenchPage'
import { Modal } from '@/shared/ui/Modal'
import { buttonVariants } from '@/shared/ui/button'
import { Input, Textarea } from '@/shared/ui/input'
import { cn } from '@/shared/lib/cn'

interface AssetDetailDialogProps {
  kind: AssetKind
  id: number
  onClose: () => void
}

interface Draft {
  appearance: string
  styling: string
  description: string
  lighting: string
  finalPrompt: string
}

// 原 .asset-detail-* 弹窗内元素（CSS Modules → Tailwind）
const detailStateClass = 'inline-flex min-h-5 items-center rounded-full bg-track px-[7px] text-[10px] font-[760] whitespace-nowrap text-content-subtle'
const detailStateReadyClass = 'bg-success-soft text-success'
const detailFieldLabelClass = 'block text-[10px] font-[780] tracking-[0.04em] text-content-subtle'
const detailFieldBoxClass = 'min-w-0 rounded-control border border-outline bg-surface-muted py-[9px] px-2.5'
const detailTextareaClass = 'min-h-[138px] resize-y'

export function AssetDetailDialog({ kind, id, onClose }: AssetDetailDialogProps) {
  const wb = useWorkbench()
  const ui = useWorkbenchUi()
  const { t } = useTranslation()

  // 实体从查询数据派生（弹窗只持草稿）
  const view: AssetView | null = useMemo(() => {
    const item =
      kind === 'character'
        ? wb.chars.find((c) => c.id === id)
        : kind === 'scene'
          ? wb.scenes.find((s) => s.id === id)
          : wb.props.find((p) => p.id === id)
    return item ? assetViewOf(kind, item) : null
  }, [kind, id, wb.chars, wb.scenes, wb.props])

  const [draft, setDraft] = useState<Draft | null>(null)
  const [baseline, setBaseline] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // 实体更新后重挂草稿（以 updatedAt 为钥；仅当无未保存编辑时跟随）
  const viewKey = view ? `${kind}:${id}:${view.updatedAt}` : ''
  const [initKey, setInitKey] = useState(viewKey)
  if (view && initKey !== viewKey && !draft) {
    setInitKey(viewKey)
  }
  if (view && !draft) {
    setDraft({
      appearance: view.appearance,
      styling: view.styling,
      description: view.description,
      lighting: view.lighting,
      finalPrompt: view.finalPrompt,
    })
    setBaseline(view.finalPrompt)
  }

  if (!view || !draft) return null

  const src = assetImageSrcOf(view.imageUrl)
  const promptDirty = draft.finalPrompt.trim() !== (baseline ?? '')

  async function genFinalPrompt() {
    if (!draft || !view) return
    const force = !!view.finalPrompt
    try {
      const fp = await wb.ensureAssetPrompt(kind, id, force)
      if (!fp) throw new Error(t('episode.asset.promptGenFailedRetry'))
      setDraft((d) => (d ? { ...d, finalPrompt: fp } : d))
      setBaseline(fp)
      toast.success(force ? t('episode.asset.promptRegenerated') : t('episode.asset.promptGenerated'))
      void wb.refresh()
    } catch (err) {
      toastError(err, { fallback: 'episode.asset.promptGenFailed' })
    }
  }

  async function copyFinalPrompt() {
    if (!draft || !view) return
    const text = draft.finalPrompt || view.finalPrompt || ''
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t('episode.asset.promptCopied'))
    } catch {
      toast.error(t('episode.asset.copyFailed'))
    }
  }

  async function save() {
    // 只提交真正修改过的字段：无修改保存不应触发后端的提示词失效置空
    const payload: Record<string, unknown> = {}
    if (kind === 'character') {
      if (draft!.appearance !== view!.appearance) payload.appearance = draft!.appearance
      if (draft!.styling !== view!.styling) payload.styling = draft!.styling
    } else if (kind === 'scene') {
      if (draft!.description !== view!.description) payload.prompt = draft!.description
      if (draft!.lighting !== view!.lighting) payload.lighting = draft!.lighting
    } else {
      if (draft!.description !== view!.description) payload.description = draft!.description
    }
    const infoChanged = Object.keys(payload).length > 0
    if (promptDirty) payload.final_prompt = draft!.finalPrompt.trim() || ''
    if (!infoChanged && !promptDirty) {
      toast.info(t('episode.asset.noChanges'))
      return
    }
    setSaving(true)
    try {
      await assetApiOf(kind).update(id, payload)
      toast.success(t('episode.asset.saved'))
      await wb.refresh()
      onClose()
    } catch (err) {
      toastError(err, { fallback: 'episode.asset.saveFailed' })
    } finally {
      setSaving(false)
    }
  }

  const title = view.name || globalT(kind === 'character' ? 'episode.asset.unnamedChar' : kind === 'prop' ? 'episode.asset.unnamedProp' : 'episode.asset.unnamedScene')
  const typeLabel = t(kind === 'character' ? 'episode.asset.typeChar' : kind === 'scene' ? 'episode.asset.typeScene' : 'episode.asset.typeProp')
  // 原 .asset-detail-edit-grid--character/--scene 单列网格；--prop 类未在样式中定义，按同款单列补齐
  const editGridClass = 'grid grid-cols-1 gap-2.5'
  // 原 .asset-detail-edit-grid--character/--scene .asset-detail-textarea { min-height: 164px }
  const editTextareaClass = kind === 'character' || kind === 'scene' ? 'min-h-[164px]' : ''

  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      width={860}
      contentClassName="max-h-[calc(100vh-56px)] max-1080:max-h-[calc(100vh-32px)]"
      title={
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-content-subtle">{typeLabel}</span>
          <span className="m-0 text-[18px] leading-[1.2] font-display text-content">{title}</span>
        </span>
      }
      showClose={false}
      footer={
        // 原 .asset-detail-foot 布局意图：次级动作居左、主操作居右
        <div className="flex min-w-0 w-full flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            <button type="button" className={buttonVariants({ variant: 'danger' })} onClick={() => ui.askDeleteAsset(kind, id, view.name)}>
              {t('common.delete')}
            </button>
            <button type="button" className={buttonVariants({})} onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
          <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
            <button type="button" className={buttonVariants({})} disabled={wb.isUploadingAsset(kind, id)} onClick={() => wb.uploadAssetImage(kind, id)}>
              {wb.isUploadingAsset(kind, id) ? <Loader2 size={11} className="animate-spin" /> : <UploadIcon />}
              {t('episode.asset.uploadImage')}
            </button>
            {kind === 'character' && (
              <button type="button" className={buttonVariants({})} disabled={wb.pendingCharImageIds.includes(id)} onClick={() => void wb.genAssetImage('character', id)}>
                {src ? t('episode.asset.regenPortrait') : wb.pendingCharImageIds.includes(id) ? t('episode.asset.generating') : t('episode.asset.genPortrait')}
              </button>
            )}
            {kind === 'scene' && (
              <button type="button" className={buttonVariants({})} disabled={wb.pendingSceneImageIds.includes(id)} onClick={() => void wb.genAssetImage('scene', id)}>
                {src ? t('episode.asset.regenScene') : wb.pendingSceneImageIds.includes(id) ? t('episode.asset.generating') : t('episode.asset.genScene')}
              </button>
            )}
            {kind === 'prop' && (
              <button type="button" className={buttonVariants({})} disabled={wb.pendingPropImageIds.includes(id)} onClick={() => void wb.genAssetImage('prop', id)}>
                {src ? t('episode.asset.regenProp') : wb.pendingPropImageIds.includes(id) ? t('episode.asset.generating') : t('episode.asset.genProp')}
              </button>
            )}
            <button type="button" className={buttonVariants({ variant: 'primary' })} disabled={saving} onClick={() => void save()}>
              {saving && <Loader2 size={12} className="animate-spin" />}
              {t('episode.asset.saveChanges')}
            </button>
          </div>
        </div>
      }
    >
      <div className="min-h-0 overflow-auto p-4">
        <div className="grid grid-cols-[minmax(280px,380px)_minmax(0,1fr)] items-start gap-3.5 max-1080:grid-cols-1">
          {/* 左：视觉预览 */}
          <aside className="sticky top-0 flex min-w-0 flex-col gap-3 max-1080:static">
            <div className="flex min-h-6 items-center justify-between gap-2.5 text-[12px] font-[820] tracking-[0.02em] text-content-secondary">
              <span>{t('episode.asset.visualPreview')}</span>
              <span className={cn(detailStateClass, src && detailStateReadyClass)}>
                {src ? t('episode.asset.ready') : t('episode.asset.todo')}
              </span>
            </div>
            <button
              type="button"
              aria-label={t('episode.viewer.imagePreview')}
              className="relative block aspect-video w-full cursor-zoom-in overflow-hidden rounded-control border border-outline bg-elevated p-0 text-content-subtle disabled:cursor-default disabled:opacity-100 focus-visible:border-[color:var(--hb-action-primary)] focus-visible:shadow-[0_0_0_3px_var(--hb-focus-ring)] focus-visible:outline-none"
              disabled={!src}
              onClick={() =>
                ui.openImage(src, `${title} ${kind === 'character' ? t('episode.asset.charPortrait') : kind === 'scene' ? t('episode.asset.sceneImage') : t('common.prop')}`)
              }
            >
              {src ? (
                <img src={thumbOf(src)} className="previewable-image block h-full w-full object-cover" onError={(e) => thumbFallback(e, src)} alt="" />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-content-subtle">
                  {kind === 'character' && (
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                  )}
                  {kind === 'prop' && (
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></svg>
                  )}
                  {kind === 'scene' && (
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" /></svg>
                  )}
                </span>
              )}
            </button>
            <div className="grid grid-cols-2 gap-2">
              <div className={detailFieldBoxClass}>
                <span className={detailFieldLabelClass}>{t('episode.asset.kindLabel')}</span>
                <strong className="mt-1 block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] leading-[1.35] text-content">
                  {kind === 'character' ? t('episode.asset.charPortrait') : kind === 'prop' ? t('common.prop') : t('episode.asset.sceneImage')}
                </strong>
              </div>
              <div className={detailFieldBoxClass}>
                <span className={detailFieldLabelClass}>{kind === 'character' ? t('episode.asset.roleLabel') : kind === 'prop' ? t('episode.asset.propTypeLabel') : t('episode.asset.timeLabel')}</span>
                <strong className="mt-1 block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] leading-[1.35] text-content">
                  {view.subLabel || (kind === 'character' ? t('common.role') : kind === 'prop' ? t('common.prop') : t('episode.asset.noTime'))}
                </strong>
              </div>
            </div>
          </aside>

          {/* 右：编辑信息 */}
          <section className="flex min-w-0 flex-col gap-3">
            <div className="flex min-h-6 items-center justify-between gap-2.5 text-[12px] font-[820] tracking-[0.02em] text-content-secondary">
              <span>{t('episode.asset.editInfo')}</span>
              {/* 原 .asset-detail-section-title .dim 覆盖 */}
              <span className="text-content-subtle text-right text-[11px] font-[560] tracking-normal">
                {kind === 'character' ? t('episode.asset.editHintChar') : kind === 'prop' ? t('episode.asset.editHintProp') : t('episode.asset.editHintScene')}
              </span>
            </div>

            {kind === 'prop' ? (
              <div className={editGridClass}>
                <label className="flex min-w-0 flex-col gap-[7px]">
                  <span className={detailFieldLabelClass}>{t('episode.asset.appearanceOfObject')}</span>
                  <Textarea
                    value={draft.description}
                    onChange={(e) => setDraft((d) => (d ? { ...d, description: e.target.value } : d))}
                    className={cn(detailTextareaClass, editTextareaClass)}
                    rows={6}
                    placeholder={t('episode.asset.appearancePlaceholder')}
                  />
                </label>
              </div>
            ) : (
              <div className={editGridClass}>
                {kind === 'character' && (
                  <>
                    <label className="flex min-w-0 flex-col gap-[7px]">
                      <span className={detailFieldLabelClass}>{t('episode.asset.appearanceField')}</span>
                      <Textarea
                        value={draft.appearance}
                        onChange={(e) => setDraft((d) => (d ? { ...d, appearance: e.target.value } : d))}
                        className={cn(detailTextareaClass, editTextareaClass)}
                        rows={6}
                        placeholder={t('episode.asset.appearanceFieldPlaceholder')}
                      />
                    </label>
                    <label className="flex min-w-0 flex-col gap-[7px]">
                      <span className={detailFieldLabelClass}>{t('episode.asset.stylingField')}</span>
                      <Textarea
                        value={draft.styling}
                        onChange={(e) => setDraft((d) => (d ? { ...d, styling: e.target.value } : d))}
                        className={cn(detailTextareaClass, editTextareaClass)}
                        rows={6}
                        placeholder={t('episode.asset.stylingFieldPlaceholder')}
                      />
                    </label>
                  </>
                )}
                {kind === 'scene' && (
                  <>
                    <label className="flex min-w-0 flex-col gap-[7px]">
                      <span className={detailFieldLabelClass}>{t('episode.asset.sceneDescField')}</span>
                      <Textarea
                        value={draft.description}
                        onChange={(e) => setDraft((d) => (d ? { ...d, description: e.target.value } : d))}
                        className={cn(detailTextareaClass, editTextareaClass)}
                        rows={5}
                        placeholder={t('episode.asset.sceneDescPlaceholder')}
                      />
                    </label>
                    <label className="flex min-w-0 flex-col gap-[7px]">
                      <span className={detailFieldLabelClass}>{t('episode.asset.sceneLightField')}</span>
                      <Textarea
                        value={draft.lighting}
                        onChange={(e) => setDraft((d) => (d ? { ...d, lighting: e.target.value } : d))}
                        className={cn(detailTextareaClass, editTextareaClass)}
                        rows={5}
                        placeholder={t('episode.asset.sceneLightPlaceholder')}
                      />
                    </label>
                  </>
                )}
              </div>
            )}
          </section>
        </div>

        {/* 最终提示词 */}
        <section className="mt-3.5 flex min-w-0 flex-col gap-2 border-t border-outline pt-3.5">
          <div className="flex min-h-6 items-center justify-between gap-2.5 text-[12px] font-[820] tracking-[0.02em] text-content-secondary">
            <span>
              {kind === 'character' ? t('episode.asset.finalPromptTurnaround') : kind === 'scene' ? t('episode.asset.finalPromptFixed') : t('episode.asset.finalPromptWhiteBg')}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                className={buttonVariants({ size: 'sm' })}
                disabled={wb.isGeneratingPrompt(kind, id) || isAssetImagePending(wb, kind, id)}
                onClick={() => void genFinalPrompt()}
              >
                {wb.isGeneratingPrompt(kind, id) && <Loader2 size={11} className="animate-spin" />}
                {wb.isGeneratingPrompt(kind, id)
                  ? t('episode.asset.generating')
                  : view.finalPrompt
                    ? t('episode.asset.regenPrompt')
                    : t('episode.asset.genPrompt')}
              </button>
              <span className={cn(detailStateClass, view.finalPrompt && detailStateReadyClass)}>
                {view.finalPrompt ? t('episode.asset.ready') : t('episode.asset.todo')}
              </span>
              {draft.finalPrompt && (
                <button type="button" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'gap-[5px]')} onClick={() => void copyFinalPrompt()}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  {t('common.copy')}
                </button>
              )}
            </div>
          </div>
          <Textarea
            value={draft.finalPrompt}
            onChange={(e) => setDraft((d) => (d ? { ...d, finalPrompt: e.target.value } : d))}
            className="max-h-[260px] min-h-24 w-full resize-y overflow-auto rounded-control border border-outline bg-surface-muted px-3.5 py-3 text-[12px] leading-[1.65] whitespace-pre-wrap break-words text-content-secondary"
            rows={5}
            placeholder={
              kind === 'character'
                ? t('episode.asset.promptPlaceholderChar')
                : kind === 'scene'
                  ? t('episode.asset.promptPlaceholderScene')
                  : t('episode.asset.promptPlaceholderProp')
            }
          />
          <p className="m-0 text-[11px] leading-[1.5] text-content-subtle">
            {kind === 'character'
              ? t('episode.asset.promptHintChar')
              : kind === 'scene'
                ? t('episode.asset.promptHintScene')
                : t('episode.asset.promptHintProp')}
          </p>
        </section>
      </div>
    </Modal>
  )
}

// ===== 新增资产弹窗 =====

interface AssetCreateDialogProps {
  kind: AssetKind
  onClose: () => void
  onSave: (draft: Record<string, string>) => Promise<void>
}

export function AssetCreateDialog({ kind, onClose, onSave }: AssetCreateDialogProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<Record<string, string>>({
    name: '',
    role: '',
    appearance: '',
    styling: '',
    location: '',
    time: '',
    prompt: '',
    lighting: '',
    type: '',
    description: '',
  })
  const [saving, setSaving] = useState(false)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }))
  const typeLabel = t(kind === 'character' ? 'common.role' : kind === 'scene' ? 'common.scene' : 'common.prop')

  function submit() {
    if (saving) return
    if (kind === 'scene' ? !draft.location?.trim() : !draft.name?.trim()) {
      toast.warning(kind === 'scene' ? t('episode.create.locationRequired') : t('episode.create.nameRequired'))
      return
    }
    setSaving(true)
    void onSave(draft)
      .catch(() => undefined)
      .finally(() => setSaving(false))
  }

  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      width={480}
      title={t('episode.create.title', { type: typeLabel })}
      showClose={false}
      footer={
        <>
          <button type="button" className={buttonVariants({})} onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" form="asset-create-form" className={buttonVariants({ variant: 'primary' })} disabled={saving}>
            {saving && <Loader2 size={12} className="animate-spin" />}
            {t('common.add')}
          </button>
        </>
      }
    >
      <form
        id="asset-create-form"
        className="flex flex-col gap-2.5"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {kind === 'character' && (
          <>
            <label className="flex flex-col gap-1.5"><span className="text-[12px] font-medium text-content-secondary">{t('episode.create.name')}</span><Input value={draft.name} onChange={set('name')} placeholder={t('episode.create.namePlaceholderChar')} /></label>
            <label className="flex flex-col gap-1.5"><span className="text-[12px] font-medium text-content-secondary">{t('episode.create.roleField')}</span><Input value={draft.role} onChange={set('role')} placeholder={t('episode.create.rolePlaceholder')} /></label>
            <label className="flex flex-col gap-1.5"><span className="text-[12px] font-medium text-content-secondary">{t('episode.asset.appearanceField')}</span><Textarea value={draft.appearance} onChange={set('appearance')} rows={3} placeholder={t('episode.create.appearancePlaceholder')} /></label>
            <label className="flex flex-col gap-1.5"><span className="text-[12px] font-medium text-content-secondary">{t('episode.asset.stylingField')}</span><Textarea value={draft.styling} onChange={set('styling')} rows={2} placeholder={t('episode.create.stylingPlaceholder')} /></label>
          </>
        )}
        {kind === 'scene' && (
          <>
            <label className="flex flex-col gap-1.5"><span className="text-[12px] font-medium text-content-secondary">{t('episode.create.location')}</span><Input value={draft.location} onChange={set('location')} placeholder={t('episode.create.locationPlaceholder')} /></label>
            <label className="flex flex-col gap-1.5"><span className="text-[12px] font-medium text-content-secondary">{t('episode.create.time')}</span><Input value={draft.time} onChange={set('time')} placeholder={t('episode.create.timePlaceholder')} /></label>
            <label className="flex flex-col gap-1.5"><span className="text-[12px] font-medium text-content-secondary">{t('episode.asset.sceneDescField')}</span><Textarea value={draft.prompt} onChange={set('prompt')} rows={3} placeholder={t('episode.create.sceneDescPlaceholder')} /></label>
            <label className="flex flex-col gap-1.5"><span className="text-[12px] font-medium text-content-secondary">{t('episode.asset.sceneLightField')}</span><Input value={draft.lighting} onChange={set('lighting')} placeholder={t('episode.create.lightPlaceholder')} /></label>
          </>
        )}
        {kind === 'prop' && (
          <>
            <label className="flex flex-col gap-1.5"><span className="text-[12px] font-medium text-content-secondary">{t('episode.create.name')}</span><Input value={draft.name} onChange={set('name')} placeholder={t('episode.create.namePlaceholderProp')} /></label>
            <label className="flex flex-col gap-1.5"><span className="text-[12px] font-medium text-content-secondary">{t('episode.create.typeField')}</span><Input value={draft.type} onChange={set('type')} placeholder={t('episode.create.typePlaceholder')} /></label>
            <label className="flex flex-col gap-1.5"><span className="text-[12px] font-medium text-content-secondary">{t('episode.asset.appearanceOfObject')}</span><Textarea value={draft.description} onChange={set('description')} rows={3} placeholder={t('episode.create.appearanceOnlyPlaceholder')} /></label>
          </>
        )}
      </form>
    </Modal>
  )
}

// ===== 局部工具 =====

function isAssetImagePending(wb: ReturnType<typeof useWorkbench>, kind: AssetKind, id: number): boolean {
  return kind === 'character'
    ? wb.pendingCharImageIds.includes(id)
    : kind === 'scene'
      ? wb.pendingSceneImageIds.includes(id)
      : wb.pendingPropImageIds.includes(id)
}

function UploadIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  )
}
