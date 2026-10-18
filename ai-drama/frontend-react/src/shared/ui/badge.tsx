/** Badge/StatusBadge — 语义 tone 徽标（旧 .tag 系列的 React 替代） */
import type { HTMLAttributes, ReactNode } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/shared/lib/cn'

export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-pill px-2.5 py-[3px] text-micro font-[550] whitespace-nowrap',
  {
    variants: {
      tone: {
        default: 'bg-track text-content-muted',
        brand: 'bg-brand-soft text-brand-content',
        success: 'bg-success-soft text-tag-success',
        error: 'bg-danger-soft text-danger',
        info: 'bg-info-soft text-tag-info',
        warning: 'bg-warning-soft text-tag-warning',
      },
      mono: { true: 'font-code', false: '' },
    },
    defaultVariants: { tone: 'default', mono: false },
  },
)

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  children?: ReactNode
}

export function Badge({ className, tone, mono, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone, mono }), className)} {...props}>
      {children}
    </span>
  )
}
