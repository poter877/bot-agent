/**
 * Switch — iOS 风格开关（旧 .switch 全局类的 React 替代）。
 * 与 hidden checkbox + label 的既有用法兼容；焦点环由外层 peer-* 驱动。
 */
import { cn } from '@/shared/lib/cn'

export interface SwitchProps {
  checked: boolean
  className?: string
  'aria-hidden'?: boolean | 'true' | 'false'
}

export function Switch({ checked, className, ...rest }: SwitchProps) {
  return (
    <span
      aria-hidden={rest['aria-hidden'] ?? true}
      className={cn(
        'relative inline-block h-[27px] w-11 shrink-0 cursor-pointer rounded-full bg-switch p-0',
        'transition-[background] duration-200 ease-app',
        'after:absolute after:top-[2px] after:left-[2px] after:h-[23px] after:w-[23px] after:rounded-full after:bg-white',
        'after:shadow-[0_2px_6px_rgba(0,0,0,0.18),0_0_1px_rgba(0,0,0,0.1)]',
        'after:transition-transform after:duration-200 after:ease-app after:content-[""]',
        checked && 'bg-success after:translate-x-[17px]',
        className,
      )}
    />
  )
}
