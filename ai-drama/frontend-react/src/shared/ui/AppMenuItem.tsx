/** AppMenuItem — 统一菜单项：选中左侧勾（占位对齐）、危险项、trailing 徽章槽 */
import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'

const itemBase =
  'flex w-full cursor-pointer items-center gap-1.5 rounded-item border-none bg-transparent px-2.5 py-[7px] ' +
  'text-left font-ui text-[12.5px] font-medium leading-[1.5] text-content-secondary ' +
  'transition-[background,color] duration-100 ease-app ' +
  'hover:bg-hover-overlay hover:text-content ' +
  'focus-visible:bg-hover-overlay focus-visible:text-content focus-visible:outline-none ' +
  'disabled:cursor-not-allowed disabled:opacity-45'

interface AppMenuItemProps {
  selected?: boolean
  danger?: boolean
  disabled?: boolean
  highlighted?: boolean
  title?: string
  onClick?: () => void
  children?: ReactNode
  trailing?: ReactNode
}

export function AppMenuItem({ selected, danger, disabled, highlighted, title, onClick, children, trailing }: AppMenuItemProps) {
  return (
    <button
      type="button"
      className={cn(
        itemBase,
        highlighted && 'bg-hover-overlay text-content',
        selected && 'font-semibold text-content',
        danger && 'text-danger hover:bg-danger-soft hover:text-danger',
        highlighted && danger && 'bg-danger-soft text-danger',
      )}
      disabled={disabled}
      role="menuitem"
      aria-selected={selected || undefined}
      title={title}
      onClick={onClick}
    >
      <Check size={12} className={cn('w-3 shrink-0 text-brand opacity-0', selected && 'opacity-100')} />
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{children}</span>
      {trailing != null && <span className="ml-auto inline-flex shrink-0 items-center gap-1">{trailing}</span>}
    </button>
  )
}

export function AppMenuGroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2.5 pt-1.5 pb-[3px] text-tiny font-bold uppercase tracking-[0.08em] text-content-subtle">
      {children}
    </div>
  )
}

export function AppMenuSep() {
  return <div className="mx-1.5 my-1 h-px bg-outline" />
}
