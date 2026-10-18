// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/config/i18n'
import { MentionTextarea, type MentionOption } from './MentionTextarea'

const options: MentionOption[] = Array.from({ length: 30 }, (_, index) => ({
  value: `角色${String(index + 1).padStart(2, '0')}`,
  label: `角色${String(index + 1).padStart(2, '0')}`,
  kind: 'character',
  group: '角色',
}))
const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')

beforeEach(async () => {
  // jsdom has no layout/scroll implementation; dispatch its scroll event explicitly below.
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  await initI18n().changeLanguage('zh')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  if (scrollIntoViewDescriptor) Object.defineProperty(Element.prototype, 'scrollIntoView', scrollIntoViewDescriptor)
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
})

function renderInput() {
  const onCommit = vi.fn()
  function Host() {
    const [value, setValue] = useState('')
    return <MentionTextarea value={value} onChange={setValue} onCommit={onCommit} options={options} aria-label="视频提示词" />
  }
  render(<Host />)
  return { onCommit, input: screen.getByRole('textbox', { name: '视频提示词' }) as HTMLTextAreaElement }
}

describe('mention candidate scrolling', () => {
  it('keeps candidates open when their list scrolls, then inserts a later candidate', async () => {
    const { input, onCommit } = renderInput()
    const user = userEvent.setup()
    await user.type(input, '@')
    const first = screen.getByRole('button', { name: '@角色01 角色' })
    const list = first.parentElement!.parentElement!
    fireEvent.scroll(list)
    expect(screen.getByRole('button', { name: '@角色30 角色' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '@角色30 角色' }))
    expect(input.value).toBe('@角色30 ')
    expect(onCommit).toHaveBeenCalledWith('@角色30 ')
    expect(screen.queryByRole('button', { name: '@角色01 角色' })).toBeNull()
  })

  it('still closes candidates when the surrounding page scrolls', async () => {
    const { input } = renderInput()
    await userEvent.setup().type(input, '@')
    expect(screen.getByRole('button', { name: '@角色01 角色' })).toBeTruthy()
    fireEvent.scroll(window)
    expect(screen.queryByRole('button', { name: '@角色01 角色' })).toBeNull()
  })

  it('preserves keyboard navigation after the highlighted candidate scrolls into view', async () => {
    const { input } = renderInput()
    const user = userEvent.setup()
    await user.type(input, '@')
    const first = screen.getByRole('button', { name: '@角色01 角色' })
    await user.keyboard('{ArrowDown}')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    fireEvent.scroll(first.parentElement!.parentElement!)
    await user.keyboard('{Enter}')
    expect(input.value).toBe('@角色02 ')
    expect(screen.queryByRole('button', { name: '@角色01 角色' })).toBeNull()
  })
})
