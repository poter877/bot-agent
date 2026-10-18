// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/config/i18n'
import { Modal } from '@/shared/ui/Modal'
import { ImageViewer, VideoViewer } from './viewers'

function renderNestedViewer(kind: 'image' | 'video') {
  const onParentClose = vi.fn()
  const onViewerClose = vi.fn()
  const title = kind === 'image' ? '角色图片预览' : '镜头视频预览'

  function TestViewers() {
    const [parentOpen, setParentOpen] = useState(true)
    const [viewerOpen, setViewerOpen] = useState(false)
    const [draft, setDraft] = useState('保留的资产草稿')
    const closeViewer = () => { setViewerOpen(false); onViewerClose() }
    return (
      <>
        <Modal open={parentOpen} onOpenChange={(open) => { setParentOpen(open); if (!open) onParentClose() }} title="资产详情">
          <label>资产名称<input value={draft} onChange={(event) => setDraft(event.target.value)} /></label>
          <button type="button" onClick={() => setViewerOpen(true)}>打开预览</button>
        </Modal>
        {kind === 'image' ? (
          <ImageViewer open={viewerOpen} src="/static/character.png" title={title} onClose={closeViewer} />
        ) : (
          <VideoViewer open={viewerOpen} src="/static/shot.mp4" downloadHref="/static/shot.mp4" title={title} onClose={closeViewer} />
        )}
      </>
    )
  }

  render(<TestViewers />)
  return { onParentClose, onViewerClose, title }
}

beforeEach(async () => {
  await initI18n().changeLanguage('zh')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe.each(['image', 'video'] as const)('%s viewer above an asset dialog', (kind) => {
  it('keeps the close button clickable and returns focus to the opener without losing the asset draft', async () => {
    const user = userEvent.setup()
    const { onParentClose, onViewerClose, title } = renderNestedViewer(kind)
    const opener = screen.getByRole('button', { name: '打开预览' })
    await user.click(opener)
    const heading = screen.getByText(title)
    await user.click(within(heading.parentElement!).getByRole('button'))

    expect(onViewerClose).toHaveBeenCalledOnce()
    expect(onParentClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: '资产详情' })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: '资产名称' }) as HTMLInputElement).value).toBe('保留的资产草稿')
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('uses the first Escape for the preview and the second Escape for the asset dialog', async () => {
    const user = userEvent.setup()
    const { onParentClose, onViewerClose } = renderNestedViewer(kind)
    await user.click(screen.getByRole('button', { name: '打开预览' }))
    await user.keyboard('{Escape}')

    expect(onViewerClose).toHaveBeenCalledOnce()
    expect(onParentClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: '资产详情' })).toBeTruthy()

    await user.keyboard('{Escape}')
    expect(onParentClose).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps keyboard focus in the preview and dismisses only that layer when its backdrop is clicked', async () => {
    const user = userEvent.setup()
    const { onParentClose, onViewerClose, title } = renderNestedViewer(kind)
    await user.click(screen.getByRole('button', { name: '打开预览' }))
    const preview = screen.getByRole('dialog', { name: title })

    await user.tab()
    expect(preview.contains(document.activeElement)).toBe(true)
    await user.tab()
    expect(preview.contains(document.activeElement)).toBe(true)
    await user.click(preview.parentElement!)

    await waitFor(() => expect(onViewerClose).toHaveBeenCalledOnce())
    expect(onParentClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: '资产详情' })).toBeTruthy()
  })
})
