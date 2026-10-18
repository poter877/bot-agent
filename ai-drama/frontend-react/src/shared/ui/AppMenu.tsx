/**
 * AppMenu — Radix Popover 管理定位、碰撞避让、外部点击和嵌套弹窗焦点。
 * 触发器由调用方通过 trigger 渲染属性自定义（保留各自形态），只统一菜单层。
 * 菜单项请使用 AppMenuItem。
 */
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'

interface AppMenuProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  placement?: 'bottom-start' | 'bottom-end' | 'bottom' | 'top-start' | 'top-end' | 'top'
  matchWidth?: boolean
  minWidth?: number
  maxHeight?: number
  /** 锚点占满整行（BaseSelect 用） */
  block?: boolean
  /** 触发器渲染：({ open }) => ReactNode */
  trigger: (state: { open: boolean }) => ReactNode
  children: ReactNode
}

export function AppMenu({
  open: controlledOpen,
  onOpenChange,
  placement = 'bottom-start',
  matchWidth = false,
  minWidth = 160,
  maxHeight = 320,
  block = false,
  trigger,
  children,
}: AppMenuProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const isOpen = controlledOpen ?? uncontrolledOpen
  const side = placement.startsWith('top') ? 'top' : 'bottom'
  const align = placement.endsWith('end') ? 'end' : placement.endsWith('start') ? 'start' : 'center'

  function setOpen(next: boolean) {
    if (controlledOpen === undefined) {
      setUncontrolledOpen(next)
    }
    onOpenChange?.(next)
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if ((event.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) return
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return

    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled):not([aria-disabled="true"])'))
    if (!items.length) return
    event.preventDefault()
    event.stopPropagation()
    const current = items.findIndex((item) => item === event.currentTarget.ownerDocument.activeElement)
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (current + 1) % items.length
          : current <= 0 ? items.length - 1 : current - 1
    items[next]?.focus()
  }

  return (
    <PopoverPrimitive.Root open={isOpen} onOpenChange={setOpen}>
      <span className={block ? 'flex w-full min-w-0' : 'inline-flex min-w-0'}>
        <PopoverPrimitive.Trigger asChild aria-haspopup="menu">
          {trigger({ open: isOpen })}
        </PopoverPrimitive.Trigger>
      </span>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={12}
          className="z-[var(--hb-z-menu)] flex max-w-[calc(100vw-24px)] flex-col overflow-y-auto rounded-panel border border-outline bg-surface p-[5px] shadow-raised outline-none data-[side=top]:animate-menu-in-top data-[side=bottom]:animate-menu-in"
          style={{
            minWidth,
            width: matchWidth ? 'var(--radix-popover-trigger-width)' : undefined,
            maxHeight: `min(${maxHeight}px, var(--radix-popover-content-available-height))`,
          }}
          role="menu"
          onKeyDown={onMenuKeyDown}
          onClick={(event) => {
            const item = (event.target as Element).closest('[role="menuitem"]')
            if (!event.defaultPrevented && item && !item.matches(':disabled, [aria-disabled="true"]')) setOpen(false)
          }}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
