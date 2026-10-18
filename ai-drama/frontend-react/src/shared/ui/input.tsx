/** Input/Textarea — 统一 field 样式（旧 .input/.textarea 的 React 替代） */
import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/shared/lib/cn'

const fieldBase =
  'w-full rounded-control border border-outline-strong bg-input font-ui text-content text-form tracking-[-0.01em] ' +
  'outline-none transition-[border-color,box-shadow,background] duration-150 ease-app ' +
  'placeholder:text-content-subtle ' +
  'hover:border-outline-hover ' +
  'focus:border-brand focus:shadow-focus ' +
  'disabled:cursor-not-allowed disabled:opacity-45'

const inputVariants = cva(fieldBase, {
  variants: {
    size: {
      default: 'px-3.5 py-[9px]',
      sm: 'px-3 py-1.5 text-caption',
    },
    invalid: {
      true: 'border-danger focus:border-danger focus:shadow-focus',
    },
  },
  defaultVariants: { size: 'default', invalid: false },
})

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>,
    VariantProps<typeof inputVariants> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, size, invalid, type = 'text', ...props },
  ref,
) {
  return <input ref={ref} type={type} className={cn(inputVariants({ size, invalid }), className)} {...props} />
})

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'size'>,
    VariantProps<typeof inputVariants> {
  resize?: 'none' | 'vertical' | 'both'
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, size, invalid, resize = 'none', rows = 3, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(inputVariants({ size, invalid }), resize === 'none' && 'resize-none', 'leading-[1.7]', className)}
      {...props}
    />
  )
})
