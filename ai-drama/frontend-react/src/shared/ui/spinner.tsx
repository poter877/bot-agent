/** Spinner / RingSpinner — 加载指示（尊重 reduced motion） */
import { cn } from '@/shared/lib/cn'
import { Loader2 } from 'lucide-react'

export function Spinner({ size = 13, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} aria-hidden className={cn('animate-spin motion-reduce:animate-none', className)} />
}

const RING_BASE =
  'inline-block shrink-0 animate-spin motion-reduce:animate-none rounded-full ' +
  'border-2 border-outline-strong border-t-brand align-middle'

/** RingSpinner — 旧 .ring-spinner 的等价替代（圆环样式，视觉与旧版一致） */
export function RingSpinner({ size = 'default', className }: { size?: 'default' | 'sm'; className?: string }) {
  return <span aria-hidden className={cn(RING_BASE, size === 'sm' ? 'size-[13px]' : 'size-[18px]', className)} />
}
