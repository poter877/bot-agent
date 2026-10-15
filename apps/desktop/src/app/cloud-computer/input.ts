import type { CloudAction } from './protocol'

export function screenPoint(
  rect: { left: number; top: number; width: number; height: number },
  width: number,
  height: number,
  x: number,
  y: number
) {
  if (rect.width <= 0 || rect.height <= 0) {
    return null
  }

  return {
    x: Math.max(0, Math.min(width - 1, Math.floor(((x - rect.left) * width) / rect.width))),
    y: Math.max(0, Math.min(height - 1, Math.floor(((y - rect.top) * height) / rect.height)))
  }
}

const keys: Record<string, string> = {
  Enter: 'Return',
  Backspace: 'BackSpace',
  Escape: 'Escape',
  Tab: 'Tab',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'Prior',
  PageDown: 'Next'
}

export function keyboardAction(event: {
  key: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  shiftKey: boolean
  isComposing?: boolean
}): CloudAction | null {
  if (event.isComposing) {
    return null
  }

  // Let the local paste event provide text; sending Ctrl+V would paste stale remote clipboard contents first.
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v' && !event.altKey) {
    return null
  }

  if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
    return { action: 'type', params: { text: event.key } }
  }

  const key = keys[event.key] ?? (/^[A-Za-z0-9]$/.test(event.key) ? event.key : undefined)

  if (!key) {
    return null
  }

  return {
    action: 'key',
    params: {
      keys: [
        ...(event.ctrlKey ? ['Control_L'] : []),
        ...(event.altKey ? ['Alt_L'] : []),
        ...(event.metaKey ? ['Super_L'] : []),
        ...(event.shiftKey ? ['Shift_L'] : []),
        key
      ]
    }
  }
}
