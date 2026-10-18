// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/config/i18n'
import { ConfirmDialog } from './ConfirmDialog'
import { LanguageSwitchDialog } from './LanguageSwitchDialog'

beforeEach(async () => {
  await initI18n().changeLanguage('zh')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderConfirm(loading = false) {
  const onCancel = vi.fn()
  const onConfirm = vi.fn()
  function Host() {
    const [open, setOpen] = useState(true)
    return <ConfirmDialog open={open} loading={loading} onConfirm={onConfirm} onCancel={() => { onCancel(); setOpen(false) }} />
  }
  render(<Host />)
  return { onCancel, onConfirm }
}

describe('confirmation dialog dismissal', () => {
  it('cancels a deletion with Escape exactly once', async () => {
    const { onCancel, onConfirm } = renderConfirm()
    await userEvent.setup().keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('calls cancellation once when clicking the cancel button', async () => {
    const { onCancel } = renderConfirm()
    await userEvent.setup().click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('keeps a pending deletion open when Escape or cancel is used', async () => {
    const { onCancel, onConfirm } = renderConfirm(true)
    const user = userEvent.setup()
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(onCancel).not.toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('cancels a language change with Escape without confirming it', async () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    function Host() {
      const [open, setOpen] = useState(true)
      return <LanguageSwitchDialog open={open} title="切换语言" message="确认切换语言？" onConfirm={onConfirm} onCancel={() => { onCancel(); setOpen(false) }} />
    }
    render(<Host />)
    await userEvent.setup().keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('calls language cancellation once when clicking cancel', async () => {
    const onCancel = vi.fn()
    render(<LanguageSwitchDialog open title="切换语言" message="确认切换语言？" onConfirm={vi.fn()} onCancel={onCancel} />)
    await userEvent.setup().click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
