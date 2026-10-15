import { describe, expect, it } from 'vitest'

import { keyboardAction, screenPoint } from './input'

describe('cloud computer input', () => {
  it('maps displayed pixels to the original screenshot and clamps an outside drag endpoint', () => {
    const rect = { left: 100, top: 200, width: 640, height: 400 }
    expect(screenPoint(rect, 1280, 800, 420, 400)).toEqual({ x: 640, y: 400 })
    expect(screenPoint(rect, 1280, 800, 9999, 0)).toEqual({ x: 1279, y: 0 })
    expect(screenPoint({ ...rect, width: 0 }, 1280, 800, 0, 0)).toBeNull()
  })

  it('uses text for ordinary Unicode input and X11 names for keyboard shortcuts', () => {
    const keys = { ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }
    expect(keyboardAction({ ...keys, key: '你' })).toEqual({ action: 'type', params: { text: '你' } })
    expect(keyboardAction({ ...keys, ctrlKey: true, key: 'l' })).toEqual({
      action: 'key',
      params: { keys: ['Control_L', 'l'] }
    })
    expect(keyboardAction({ ...keys, key: 'Enter' })).toEqual({ action: 'key', params: { keys: ['Return'] } })
    expect(keyboardAction({ ...keys, key: 'Process', isComposing: true })).toBeNull()
  })
})
