/** UI 语言订阅：以 preferences store 为单一真源（i18next.changeLanguage 同步） */
import { useSyncExternalStore } from 'react'
import { usePreferences, type UiLocale } from './preferences'

const listeners = new Set<() => void>()
let snapshot: UiLocale = usePreferences.getState().uiLocale

usePreferences.subscribe((s) => {
  if (s.uiLocale !== snapshot) {
    snapshot = s.uiLocale
    for (const fn of listeners) fn()
  }
})

export function useUiLocale(): UiLocale {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => snapshot,
    () => 'zh',
  )
}
