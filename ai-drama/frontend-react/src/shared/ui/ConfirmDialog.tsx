/**
 * ConfirmDialog — 删除/危险操作确认弹窗（Radix AlertDialog：Esc=取消、焦点圈闭）。
 * 确认/取消结果明确；请求期间按钮禁用防重复点击。
 */
import { createPortal } from 'react-dom'
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog'
import { Loader2, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/shared/lib/cn'
import { buttonVariants } from '@/shared/ui/button'

interface ConfirmDialogProps {
  open: boolean
  title?: string
  message?: string
  confirmText?: string
  loadingText?: string
  loading?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText,
  loadingText,
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation()
  const effectiveTitle = title || t('components.confirmDialog.title')
  const effectiveConfirmText = confirmText || t('common.delete')
  const effectiveLoadingText = loadingText || t('common.deleteLoading')

  return createPortal(
    <AlertDialogPrimitive.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !loading) onCancel() }}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-scrim p-6 backdrop-blur-[8px] animate-fade-in">
          <AlertDialogPrimitive.Content
            className="relative flex max-h-[calc(100dvh-48px)] w-[400px] max-w-full flex-col items-center overflow-y-auto rounded-dialog bg-surface px-6 pt-7 pb-5 text-center shadow-dialog animate-scale-in"
            style={{ zIndex: 101 }}
            aria-describedby={undefined}
            onEscapeKeyDown={(event) => { if (loading) event.preventDefault() }}
          >
            <div className="mx-auto mb-3.5 flex size-[52px] items-center justify-center rounded-full bg-danger-soft text-danger">
              <Trash2 size={20} strokeWidth={1.8} />
            </div>
            <AlertDialogPrimitive.Title className="text-base font-bold tracking-[-0.01em] text-content">
              {effectiveTitle}
            </AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description className="mt-2 max-w-80 break-words text-[13px] leading-[1.65] text-content-muted">
              {message}
            </AlertDialogPrimitive.Description>
            <div className="mt-[22px] flex w-full gap-2.5">
              <AlertDialogPrimitive.Cancel type="button" className={cn(buttonVariants({}), "flex-1")} disabled={loading}>
                {t('common.cancel')}
              </AlertDialogPrimitive.Cancel>
              <button
                type="button"
                className={cn(
                  buttonVariants({ variant: 'danger' }), 'flex-1',
                  'disabled:opacity-60',
                )}
                disabled={loading}
                onClick={onConfirm}
              >
                {loading && <Loader2 size={13} className="animate-spin" />}
                {loading ? effectiveLoadingText : effectiveConfirmText}
              </button>
            </div>
          </AlertDialogPrimitive.Content>
        </AlertDialogPrimitive.Overlay>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>,
    document.body,
  )
}
