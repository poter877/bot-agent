/**
 * Button/IconButton — 统一 variants（旧 .btn 全局类的 React 替代）。
 *
 * 类名表保留完整静态字符串供 Tailwind 扫描（禁止拼接）。
 * 状态样式消费已有协议：loading 由调用方传入，键盘焦点 focus-visible，
 * reduced motion 下降级 transition。视觉与旧 .btn 基线一致（36px/渐变/glow/按压）。
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'
import { cn } from '@/shared/lib/cn'

export const buttonVariants = cva(
  // base：高度/字体/圆角/焦点/disabled/motion
  'inline-flex appearance-none items-center justify-center gap-1.5 rounded-pill border-0 ' +
    'font-ui font-semibold text-ui leading-none whitespace-nowrap select-none ' +
    'tracking-[-0.01em] no-underline cursor-pointer ' +
    'transition-[background,color,box-shadow,transform] duration-150 ease-app ' +
    'focus-visible:outline-none focus-visible:shadow-focus ' +
    'disabled:cursor-not-allowed disabled:opacity-45 ' +
    'motion-reduce:transition-none',
  {
    variants: {
      variant: {
        default:
          'bg-button text-button-content shadow-item hover:bg-button-hover hover:text-button-content hover:shadow-item active:scale-[0.97]',
        primary:
          'bg-brand-gradient text-on-action ' +
          'hover:bg-brand-gradient hover:text-on-action hover:shadow-brand-glow hover:scale-[1.03] ' +
          'active:scale-100 active:brightness-95 motion-reduce:hover:scale-100',
        ghost: 'bg-transparent text-brand-content shadow-none hover:bg-brand-soft hover:text-brand-content hover:shadow-none',
        danger: 'bg-danger-soft text-danger hover:bg-danger-soft-hover hover:text-danger',
      },
      size: {
        default: 'min-h-9 px-[18px]',
        sm: 'min-h-[30px] px-[14px] text-caption gap-1',
        icon: 'size-9 min-h-9 min-w-9 shrink-0 p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** loading 时按钮保持宽度与可访问名称，spinner 不挤压文案 */
  loading?: boolean
  children?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, loading, disabled, children, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Loader2 size={13} aria-hidden className="animate-spin motion-reduce:animate-none" />}
      {children}
    </button>
  )
})

/** IconButton — 图标按钮（方形；可访问名称经 aria-label 或 title 提供） */
export interface IconButtonProps extends Omit<ButtonProps, 'children'> {
  children: ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, variant, loading, children, ...props },
  ref,
) {
  return (
    <Button ref={ref} className={cn('p-0', className)} variant={variant} size="icon" loading={loading} {...props}>
      {children}
    </Button>
  )
})
