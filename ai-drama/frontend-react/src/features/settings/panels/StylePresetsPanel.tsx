/** 风格预设面板：列表、启停、CRUD（value 创建后不可改） */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Palette, Pencil, Plus, Trash2 } from 'lucide-react'
import { qk } from '@/shared/api/query-keys'
import { stylePresetApi, type StylePreset } from '@/entities/settings/api'
import { toastError } from '@/shared/lib/errors'
import { Button } from '@/shared/ui/button'
import { Badge } from '@/shared/ui/badge'
import { cardVariants } from '@/shared/ui/card'
import { Input, Textarea } from '@/shared/ui/input'
import { Switch } from '@/shared/ui/switch'
import { ConfirmDialog } from '@/shared/ui/ConfirmDialog'
import { Modal } from '@/shared/ui/Modal'
import { cn } from '@/shared/lib/cn'

interface StyleForm {
  name: string
  value: string
  prompt: string
  description: string
  sort_order: number
}

// settings-scroll 直接子元素限宽居中
const PANEL_SCROLL = 'h-full overflow-y-auto px-7 pt-5 pb-12 animate-fade-up'
const CONTENT_W = 'mx-auto w-full max-w-[1080px]'
const SETTINGS_HEAD = `${CONTENT_W} mb-5`
const SETTINGS_TITLE = 'text-[22px] font-extrabold tracking-[-0.02em]'
const SETTINGS_DESC = 'mt-1.5 text-[13px] text-content-muted'
const SVC_GROUP = 'overflow-hidden'
const SVC_GROUP_HEAD = 'flex items-center gap-2.5 border-b border-outline px-5 py-3.5'
const SVC_GROUP_HEADING = 'min-w-0'
const SVC_GROUP_TITLE = 'text-body font-bold text-content'
const SVC_GROUP_SUB = 'mt-0.5 text-[11.5px] text-content-subtle'
const CONFIG_ROW = 'flex items-center gap-3 px-5 py-3'
const PROVIDER_BADGE =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-brand text-[14px] font-bold text-on-action shadow-[0_1px_4px_rgba(0,0,0,0.12)]'
const CONFIG_MAIN = 'flex min-w-0 flex-1 flex-col gap-[3px]'
const CONFIG_LINE = 'flex min-w-0 items-center gap-2'
const CONFIG_NAME = 'text-form font-[650] text-content'
const CONFIG_SUB = 'text-[11.5px] text-content-subtle'
const CONFIG_EMPTY = 'px-5 py-3.5 text-[12px] text-content-subtle'
const CONFIG_SWITCH = 'inline-flex shrink-0 cursor-pointer'
const CONFIG_DIALOG = 'w-[min(720px,calc(100vw-40px))]'
const CONFIG_DIALOG_BODY = 'flex flex-col gap-3.5'
const DIALOG_SUB = 'mt-1 text-[12px] text-content-muted'
// 原全局 .btn-icon.btn-sm 尺寸收窄（30px）
const ICON_BTN_SM = 'h-[30px] min-h-[30px] w-[30px] min-w-[30px]'

export function StylePresetsPanel() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const presetsQuery = useQuery({
    queryKey: qk.stylePresets(true),
    queryFn: ({ signal }) => stylePresetApi.list(true, signal),
    staleTime: 30_000,
  })
  const stylePresets = presetsQuery.data ?? []

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: qk.stylePresets(true) })

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [form, setForm] = useState<StyleForm>({ name: '', value: '', prompt: '', description: '', sort_order: 0 })
  const [toDelete, setToDelete] = useState<StylePreset | null>(null)

  const toggleMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) => stylePresetApi.update(id, { is_active }),
    onSuccess: invalidate,
    onError: (err) => toastError(err),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => stylePresetApi.del(id),
    onSuccess: () => {
      toast.success(t('index.deleted'))
      setToDelete(null)
      invalidate()
    },
    onError: (err) => toastError(err),
  })

  const saveMutation = useMutation({
    mutationFn: (form: StyleForm) => {
      if (editId) {
        return stylePresetApi.update(editId, {
          name: form.name,
          prompt: form.prompt,
          description: form.description,
          sort_order: form.sort_order,
        })
      }
      return stylePresetApi.create({ ...form })
    },
    onSuccess: () => {
      setDialogOpen(false)
      toast.success(t('common.saved'))
      invalidate()
    },
    onError: (err) => toastError(err),
  })

  function submitStyle() {
    if (!form.name?.trim() || !form.prompt?.trim() || (!editId && !form.value?.trim())) {
      toast.warning(t('settings.styleDialog.required'))
      return
    }
    saveMutation.mutate(form)
  }

  function startAdd() {
    setEditId(null)
    setForm({
      name: '',
      value: '',
      prompt: '',
      description: '',
      sort_order: (stylePresets.at(-1)?.sortOrder ?? 0) + 1,
    })
    setDialogOpen(true)
  }

  function startEdit(p: StylePreset) {
    setEditId(p.id)
    setForm({
      name: p.name,
      value: p.value,
      prompt: p.prompt,
      description: p.description || '',
      sort_order: p.sortOrder ?? 0,
    })
    setDialogOpen(true)
  }

  return (
    <div className={PANEL_SCROLL}>
      <div className={SETTINGS_HEAD}>
        <h2 className={SETTINGS_TITLE}>{t('settings.styles.title')}</h2>
        <p className={SETTINGS_DESC}>{t('settings.styles.desc')}</p>
      </div>
      <section className={cn(cardVariants(), CONTENT_W, SVC_GROUP)}>
        <div className={SVC_GROUP_HEAD}>
          <div className={SVC_GROUP_HEADING}>
            <span className={SVC_GROUP_TITLE}>{t('settings.styles.allTitle')}</span>
            <div className={SVC_GROUP_SUB}>
              {t('settings.styles.count', {
                active: stylePresets.filter((p) => p.isActive).length,
                total: stylePresets.length,
              })}
            </div>
          </div>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={startAdd}>
            <Plus size={13} /> {t('common.add')}
          </Button>
        </div>
        {stylePresets.map((p, i) => (
          <div key={p.id} className={cn(CONFIG_ROW, i > 0 && 'border-t border-outline')}>
            <div className={PROVIDER_BADGE}>
              <Palette size={15} />
            </div>
            <div className={CONFIG_MAIN}>
              <div className={CONFIG_LINE}>
                <span className={CONFIG_NAME}>{p.name}</span>
                <Badge mono>{p.value}</Badge>
                {!p.isActive && <Badge>{t('settings.common.disabled')}</Badge>}
              </div>
              <div className={`font-code truncate ${CONFIG_SUB}`}>{p.prompt}</div>
              {p.description && <div className={`truncate ${CONFIG_SUB}`}>{p.description}</div>}
            </div>
            <label className={CONFIG_SWITCH}>
              <input
                type="checkbox"
                className="sr-only peer"
                checked={p.isActive}
                onChange={() => toggleMutation.mutate({ id: p.id, is_active: !p.isActive })}
              />
              <Switch checked={p.isActive} className="peer-focus-visible:shadow-focus" />
            </label>
            <Button variant="ghost" size="icon" className={ICON_BTN_SM} onClick={() => startEdit(p)}>
              <Pencil size={13} />
            </Button>
            <Button variant="danger" size="icon" className={ICON_BTN_SM} onClick={() => setToDelete(p)}>
              <Trash2 size={13} />
            </Button>
          </div>
        ))}
        {!stylePresets.length && <p className={CONFIG_EMPTY}>{t('settings.styles.empty')}</p>}
      </section>

      {/* Style Preset Dialog */}
      <Modal
        open={dialogOpen}
        onOpenChange={(v) => !v && setDialogOpen(false)}
        width={480}
        contentClassName={CONFIG_DIALOG}
        title={
          <span>
            <span>{editId ? t('settings.styleDialog.editTitle') : t('settings.styleDialog.addTitle')}</span>
            <span className={DIALOG_SUB}>{t('settings.styleDialog.sub')}</span>
          </span>
        }
        showClose={false}
        footer={
          <>
            <Button onClick={() => setDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" form="style-preset-form" variant="primary">{t('common.save')}</Button>
          </>
        }
      >
        <form
          id="style-preset-form"
          className={CONFIG_DIALOG_BODY}
          onSubmit={(e) => {
            e.preventDefault()
            submitStyle()
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-[550] text-content-secondary">
              {t('settings.styleDialog.name')} <span className="text-danger">*</span>
            </span>
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder={t('settings.styleDialog.namePlaceholder')} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-[550] text-content-secondary">
              {t('settings.styleDialog.key')} <span className="text-danger">*</span>
            </span>
            <Input value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} className="font-code" placeholder={t('settings.styleDialog.keyPlaceholder')} disabled={!!editId} />
            <span className="text-micro leading-[1.5] text-content-subtle">{t('settings.styleDialog.keyHint')}</span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-[550] text-content-secondary">
              {t('settings.styleDialog.prompt')} <span className="text-danger">*</span>
            </span>
            <Textarea value={form.prompt} onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))} rows={3} placeholder={t('settings.styleDialog.promptPlaceholder')} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-[550] text-content-secondary">{t('settings.styleDialog.description')}</span>
            <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder={t('settings.styleDialog.descPlaceholder')} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-[550] text-content-secondary">{t('settings.styleDialog.sort')}</span>
            <Input
              value={form.sort_order}
              onChange={(e) => setForm((f) => ({ ...f, sort_order: Number(e.target.value) || 0 }))}
              type="number"
              min={0}
              max={999}
            />
          </label>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!toDelete}
        title={t('settings.styleDelete.title')}
        message={t('settings.styleDelete.message', { name: toDelete?.name })}
        loading={deleteMutation.isPending}
        onConfirm={() => toDelete && deleteMutation.mutate(toDelete.id)}
        onCancel={() => setToDelete(null)}
      />
    </div>
  )
}
