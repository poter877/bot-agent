// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppMenu } from './AppMenu'
import { AppMenuItem } from './AppMenuItem'

afterEach(cleanup)

describe('AppMenu keyboard navigation', { timeout: 30_000 }, () => {
  it('moves between enabled menu items with arrows, Home and End', async () => {
    const user = userEvent.setup()
    const select = vi.fn()
    render(
      <AppMenu trigger={() => <button type="button">操作</button>}>
        <AppMenuItem onClick={() => select('first')}>第一项</AppMenuItem>
        <AppMenuItem disabled>不可用项</AppMenuItem>
        <AppMenuItem onClick={() => select('last')}>最后一项</AppMenuItem>
      </AppMenu>,
    )
    await user.click(screen.getByRole('button', { name: '操作' }))
    const first = screen.getByRole('menuitem', { name: '第一项' })
    const last = screen.getByRole('menuitem', { name: '最后一项' })
    expect(document.activeElement).toBe(first)
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(last)
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(first)
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(last)
    await user.keyboard('{Home}')
    expect(document.activeElement).toBe(first)
    await user.keyboard('{End}{Enter}')
    expect(select).toHaveBeenCalledWith('last')
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
