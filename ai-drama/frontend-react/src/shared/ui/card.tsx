/** Card — 卡片容器（旧 .card/.card-active 的 React 替代） */
import { forwardRef, type HTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/shared/lib/cn'

export const cardVariants = cva(
  'rounded-panel border border-outline bg-surface shadow-card hover:border-outline-strong ' +
    'transition-[box-shadow,transform,border-color] duration-200 ease-app',
  {
    variants: {
      /** 可点击卡片：pointer + 焦点环 */
      interactive: {
        true: 'cursor-pointer focus-visible:outline-none focus-visible:shadow-focus',
        false: '',
      },
      selected: { true: 'border-brand shadow-[0_0_0_3px_var(--hb-focus-ring)]', false: '' },
    },
    defaultVariants: { interactive: false, selected: false },
  },
)

export interface CardProps extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof cardVariants> {}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, interactive, selected, ...props },
  ref,
) {
  return <div ref={ref} className={cn(cardVariants({ interactive, selected }), className)} {...props} />
})
