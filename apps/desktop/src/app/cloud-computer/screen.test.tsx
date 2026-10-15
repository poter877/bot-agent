import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { CloudComputerCaptureResult } from './protocol'
import { CloudScreen } from './screen'

const frame: CloudComputerCaptureResult = {
  computerGeneration: 1,
  leaseEpoch: 1,
  image: { mediaType: 'image/png', data: 'aW1hZ2U=', width: 1280, height: 800 }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('maps pointer input using the displayed image dimensions, and blocks it for observers', () => {
  const onAction = vi.fn(async () => {})
  const view = render(<CloudScreen controlling={false} frame={frame} label="Screen" onAction={onAction} />)
  const image = screen.getByRole('img')
  const canvas = screen.getByRole('application')
  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 50, width: 640, height: 400 } as DOMRect)
  Object.defineProperty(canvas, 'setPointerCapture', { value: vi.fn() })

  const pointer = (type: string, x: number, y: number) =>
    fireEvent(image, new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }))

  pointer('pointerdown', 260, 150)
  pointer('pointerup', 260, 150)
  expect(onAction).not.toHaveBeenCalled()
  view.rerender(<CloudScreen controlling frame={frame} label="Screen" onAction={onAction} />)
  pointer('pointerdown', 260, 150)
  pointer('pointerup', 260, 150)
  expect(onAction).toHaveBeenLastCalledWith({ action: 'click', params: { x: 320, y: 200, button: 'left', clicks: 1 } })
  pointer('pointerdown', 260, 150)
  pointer('pointerup', 420, 250)
  expect(onAction).toHaveBeenLastCalledWith({
    action: 'drag',
    params: { fromX: 320, fromY: 200, toX: 640, toY: 400, durationMs: 300 }
  })
})

it('sends focused Unicode and X11 shortcuts but ignores composing and observer keystrokes', () => {
  const onAction = vi.fn(async () => {})
  const view = render(<CloudScreen controlling frame={frame} label="Screen" onAction={onAction} />)
  const canvas = screen.getByRole('application')
  fireEvent.keyDown(canvas, { key: '好' })
  expect(onAction).toHaveBeenLastCalledWith({ action: 'type', params: { text: '好' } })
  fireEvent.keyDown(canvas, { key: 'a', ctrlKey: true })
  expect(onAction).toHaveBeenLastCalledWith({ action: 'key', params: { keys: ['Control_L', 'a'] } })
  fireEvent.keyDown(canvas, { key: '中', isComposing: true })
  view.rerender(<CloudScreen controlling={false} frame={frame} label="Screen" onAction={onAction} />)
  fireEvent.keyDown(canvas, { key: 'x' })
  expect(onAction).toHaveBeenCalledTimes(2)
})

it('pastes local text once without first pasting the remote computer clipboard', () => {
  const onAction = vi.fn(async () => {})
  render(<CloudScreen controlling frame={frame} label="Screen" onAction={onAction} />)
  const canvas = screen.getByRole('application')
  fireEvent.keyDown(canvas, { key: 'v', ctrlKey: true })
  fireEvent.paste(canvas, { clipboardData: { getData: () => '本机文字' } })
  expect(onAction.mock.calls).toEqual([[{ action: 'type', params: { text: '本机文字' } }]])
})
