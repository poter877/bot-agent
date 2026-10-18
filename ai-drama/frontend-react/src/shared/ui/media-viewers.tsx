/** 项目与工作台共用的图片/视频查看器，浮层和焦点交由 Radix Dialog 管理。 */
import { useRef, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useTranslation } from 'react-i18next'
import { buttonVariants } from '@/shared/ui/button'
import { cn } from '@/shared/lib/cn'

interface ImageViewerProps {
  open: boolean
  src: string
  title: string
  onClose: () => void
}

// 原 .overlay（全局）+ .image-viewer-overlay 覆盖（z/padding）
const viewerOverlayClass =
  'fixed inset-0 z-[118] flex items-center justify-center overflow-y-auto bg-scrim backdrop-blur-[8px] animate-fade-in p-7 max-1080:p-4'
const dialogClass =
  'relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden rounded-dialog bg-surface shadow-dialog outline-none animate-scale-in'
const imageViewerDialogClass =
  'w-[min(1100px,calc(100vw-56px))] max-h-[calc(100dvh-56px)] bg-header backdrop-blur-[20px] backdrop-saturate-[1.8] max-1080:w-[calc(100vw-32px)] max-1080:max-h-[calc(100dvh-32px)]'
const viewerHeadClass = 'flex shrink-0 flex-wrap items-center gap-3 border-b border-outline px-[18px] py-4'
const viewerTitleClass = 'min-w-0 flex-1 break-words text-[14px] font-bold font-display text-content-secondary'

interface ViewerDialogProps {
  open: boolean
  title: string
  onClose: () => void
  className?: string
  toolbar?: ReactNode
  children: ReactNode
}

function ViewerDialog({ open, title, onClose, className, toolbar, children }: ViewerDialogProps) {
  const { t } = useTranslation()
  // 查看器由页面状态打开，没有 Dialog.Trigger，需要自行记录并恢复打开位置。
  const openerRef = useRef<HTMLElement | null>(null)

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={viewerOverlayClass}>
          <DialogPrimitive.Content
            className={cn(dialogClass, imageViewerDialogClass, className)}
            aria-describedby={undefined}
            onOpenAutoFocus={() => {
              openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              if (openerRef.current?.isConnected) openerRef.current.focus()
            }}
          >
            <div className={viewerHeadClass}>
              <DialogPrimitive.Title className={viewerTitleClass}>{title}</DialogPrimitive.Title>
              {toolbar}
              <DialogPrimitive.Close asChild>
                <button type="button" aria-label={t('common.close')} className={buttonVariants({ variant: 'ghost', size: 'icon' })}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </DialogPrimitive.Close>
            </div>
            {children}
          </DialogPrimitive.Content>
        </DialogPrimitive.Overlay>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export function ImageViewer({ open, src, title, onClose }: ImageViewerProps) {
  const { t } = useTranslation()
  return (
    <ViewerDialog open={open && !!src} title={title || t('episode.viewer.imagePreview')} onClose={onClose}>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-5">
        <img src={src} alt={title || t('episode.viewer.imagePreview')} className="block max-h-[calc(100dvh-140px)] max-w-full rounded-[18px] bg-surface-muted shadow-dialog" />
      </div>
    </ViewerDialog>
  )
}

interface VideoViewerProps {
  open: boolean
  title: string
  meta?: string
  src: string
  downloadHref: string
  downloadLabel?: string
  onClose: () => void
}

export function VideoViewer({ open, title, meta, src, downloadHref, downloadLabel, onClose }: VideoViewerProps) {
  const { t } = useTranslation()
  return (
    <ViewerDialog
      open={open && !!src}
      title={title}
      onClose={onClose}
      className="w-[min(1080px,calc(100vw-56px))]"
      toolbar={
        <>
          {meta && <span className="text-content-subtle" style={{ fontSize: 11 }}>{meta}</span>}
          <a href={downloadHref} download className={buttonVariants({ size: 'sm' })}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {downloadLabel || t('common.download')}
          </a>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-[18px]">
        <video key={src} src={src} controls autoPlay playsInline className="block max-h-[calc(100dvh-220px)] w-full rounded-control bg-black" />
      </div>
    </ViewerDialog>
  )
}
