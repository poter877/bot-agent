/**
 * Modal — 基于 Radix Dialog 的通用弹窗外壳（焦点圈闭、Esc、滚动锁定、可访问性名称）。
 * 遮罩负责视口居中，内容区独立滚动，嵌套浮层沿用 Radix 焦点与交互管理。
 */
import { createPortal } from 'react-dom'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'
import { buttonVariants } from '@/shared/ui/button'

interface ModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  icon?: ReactNode
  width?: number
  children?: ReactNode
  footer?: ReactNode
  /** 点击遮罩关闭（默认 true；编辑中的表单建议关闭以防误触丢稿） */
  overlayClosable?: boolean
  showClose?: boolean
  /** 附加到 .dialog 内容元素的类（如 config-dialog） */
  contentClassName?: string
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  icon,
  width,
  children,
  footer,
  overlayClosable = true,
  showClose = true,
  contentClassName,
}: ModalProps) {
  return createPortal(
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-scrim p-6 backdrop-blur-[8px] animate-fade-in">
          <DialogPrimitive.Content
            className={cn(
              'relative flex max-h-[calc(100dvh-48px)] min-w-0 w-full flex-col overflow-hidden rounded-dialog bg-surface shadow-dialog animate-scale-in',
              contentClassName,
            )}
            style={{ width, maxWidth: '100%', zIndex: 101 }}
            onInteractOutside={(e) => {
              if (!overlayClosable) e.preventDefault()
            }}
          >
            <div className="flex shrink-0 items-center gap-3 border-b border-outline px-6 pt-5 pb-4">
              {icon}
              <DialogPrimitive.Title className="text-[17px] font-bold">{title}</DialogPrimitive.Title>
              {showClose && (
                <DialogPrimitive.Close type="button" className={cn(buttonVariants({ size: 'icon' }), 'ml-auto bg-transparent text-content-muted shadow-none hover:bg-hover-overlay hover:text-content hover:shadow-none')} aria-label="close">
                  <X size={15} strokeWidth={1.8} />
                </DialogPrimitive.Close>
              )}
            </div>
            {description && (
              <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>
            )}
            {description == null && (
              <DialogPrimitive.Description className="sr-only">{typeof title === 'string' ? title : ''}</DialogPrimitive.Description>
            )}
            {children && <div className="min-h-0 flex-1 overflow-y-auto p-6">{children}</div>}
            {footer && <div className="flex shrink-0 justify-end gap-3 border-t border-outline px-6 py-4">{footer}</div>}
          </DialogPrimitive.Content>
        </DialogPrimitive.Overlay>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>,
    document.body,
  )
}
