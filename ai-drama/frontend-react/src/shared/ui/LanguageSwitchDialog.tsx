/**
 * LanguageSwitchDialog — 统一语言切换确认弹窗：明确区分确认/取消结果，
 * 取消不写任何设置（旧行为为两个按钮等价，本版修正）。
 */
import { createPortal } from 'react-dom'
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog'
import { Languages } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/shared/lib/cn'
import { buttonVariants } from './button'

interface LanguageSwitchDialogProps {
  open: boolean
  title: string
  message: string
  onConfirm: () => void
  onCancel: () => void
}

export function LanguageSwitchDialog({ open, title, message, onConfirm, onCancel }: LanguageSwitchDialogProps) {
  const { t } = useTranslation()
  return createPortal(
    <AlertDialogPrimitive.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onCancel() }}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-scrim p-6 backdrop-blur-[8px] animate-fade-in">
          <AlertDialogPrimitive.Content
            className="relative flex max-h-[calc(100dvh-48px)] w-[420px] max-w-full flex-col items-center overflow-y-auto rounded-dialog bg-surface px-6 pt-7 pb-5 text-center shadow-dialog animate-scale-in"
            style={{ zIndex: 101 }}
            aria-describedby={undefined}
          >
            <div className="mx-auto mb-3.5 flex size-[52px] items-center justify-center rounded-full bg-brand-soft text-brand-content">
              <Languages size={20} strokeWidth={1.8} />
            </div>
            <AlertDialogPrimitive.Title className="text-base font-bold tracking-[-0.01em] text-content">
              {title}
            </AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description className="mt-2 max-w-[340px] break-words text-[13px] leading-[1.65] text-content-muted">
              {message}
            </AlertDialogPrimitive.Description>
            <ul className="mt-2.5 mb-0.5 flex list-disc flex-col gap-1 pl-[18px] text-left text-[12.5px] leading-[1.5] text-content-muted marker:text-brand">
              <li>{t('components.langSwitch.effectUi')}</li>
              <li>{t('components.langSwitch.effectAi')}</li>
              <li>{t('components.langSwitch.effectRefresh')}</li>
            </ul>
            <div className="mt-[22px] flex w-full gap-2.5">
              <AlertDialogPrimitive.Cancel type="button" className={cn(buttonVariants(), 'flex-1')}>
                {t('common.cancel')}
              </AlertDialogPrimitive.Cancel>
              <button type="button" className={cn(buttonVariants({ variant: 'primary' }), 'flex-1')} onClick={onConfirm}>
                {t('components.langSwitch.confirm')}
              </button>
            </div>
          </AlertDialogPrimitive.Content>
        </AlertDialogPrimitive.Overlay>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>,
    document.body,
  )
}
