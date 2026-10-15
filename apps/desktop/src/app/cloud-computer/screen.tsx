import { useRef } from 'react'

import { keyboardAction, screenPoint } from './input'
import type { CloudAction, CloudComputerCaptureResult } from './protocol'

interface CloudScreenProps {
  frame: CloudComputerCaptureResult
  controlling: boolean
  label: string
  onAction: (action: CloudAction) => Promise<void>
}

export function CloudScreen({ frame, controlling, label, onAction }: CloudScreenProps) {
  const image = useRef<HTMLImageElement>(null)
  const pressed = useRef<{ x: number; y: number; button: number } | null>(null)
  const lastMove = useRef(0)

  const point = (x: number, y: number) =>
    image.current
      ? screenPoint(image.current.getBoundingClientRect(), frame.image.width, frame.image.height, x, y)
      : null

  return (
    <div
      aria-label={label}
      className="flex h-full min-h-0 items-center justify-center overflow-hidden bg-(--ui-bg-tertiary) outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-remote-screen=""
      data-terminal=""
      onContextMenu={event => {
        if (controlling) {
          event.preventDefault()
        }
      }}
      onKeyDown={event => {
        if (!controlling) {
          return
        }

        const action = keyboardAction({ ...event, isComposing: event.nativeEvent.isComposing })

        if (action) {
          event.preventDefault()
          event.stopPropagation()
          void onAction(action)
        }
      }}
      onPaste={event => {
        if (!controlling) {
          return
        }

        const text = event.clipboardData.getData('text')

        if (text && text.length <= 8000) {
          event.preventDefault()
          void onAction({ action: 'type', params: { text } })
        }
      }}
      onPointerCancel={() => {
        pressed.current = null
      }}
      onPointerDown={event => {
        if (!controlling || event.target !== image.current) {
          return
        }

        const at = point(event.clientX, event.clientY)

        if (!at) {
          return
        }

        event.preventDefault()
        event.currentTarget.focus()
        event.currentTarget.setPointerCapture(event.pointerId)
        pressed.current = { ...at, button: event.button }
      }}
      onPointerMove={event => {
        if (!controlling || pressed.current || event.target !== image.current || Date.now() - lastMove.current < 300) {
          return
        }

        const at = point(event.clientX, event.clientY)

        if (at) {
          lastMove.current = Date.now()
          void onAction({ action: 'move', params: at })
        }
      }}
      onPointerUp={event => {
        const from = pressed.current
        pressed.current = null

        if (!controlling || !from) {
          return
        }

        const to = point(event.clientX, event.clientY)

        if (!to) {
          return
        }

        if (Math.hypot(to.x - from.x, to.y - from.y) > 3 && from.button === 0) {
          void onAction({
            action: 'drag',
            params: { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, durationMs: 300 }
          })
        } else {
          void onAction({
            action: 'click',
            params: { ...to, button: from.button === 2 ? 'right' : from.button === 1 ? 'middle' : 'left', clicks: 1 }
          })
        }
      }}
      onWheel={event => {
        if (!controlling) {
          return
        }

        const at = point(event.clientX, event.clientY)

        if (!at) {
          return
        }

        event.preventDefault()
        const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY)
        const delta = horizontal ? event.deltaX : event.deltaY

        if (delta) {
          void onAction({
            action: 'scroll',
            params: {
              ...at,
              direction: horizontal ? (delta > 0 ? 'right' : 'left') : delta > 0 ? 'down' : 'up',
              amount: Math.min(20, Math.max(1, Math.ceil(Math.abs(delta) / 100)))
            }
          })
        }
      }}
      role="application"
      tabIndex={controlling ? 0 : -1}
    >
      <img
        alt={label}
        className="max-h-full max-w-full select-none object-contain"
        draggable={false}
        ref={image}
        src={`data:${frame.image.mediaType};base64,${frame.image.data}`}
      />
    </div>
  )
}
