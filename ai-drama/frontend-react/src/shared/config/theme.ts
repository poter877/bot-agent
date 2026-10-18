/**
 * 主题控制器 — 模块级单例（与旧 useTheme 同构，框架无关）。
 * - 首帧主题由 index.html 内联脚本写入（读偏好新键 + 旧键兜底），本模块接管后续切换
 * - 跟随系统：matchMedia('(prefers-color-scheme: dark)')，订阅成对注册，Web/桌面通用
 * - React 侧经 useTheme() 以 useSyncExternalStore 订阅，字段级重渲染
 */
import { useSyncExternalStore } from 'react'
import { usePreferences, type ThemeMode } from './preferences'

export type ResolvedTheme = 'light' | 'dark'

export const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system']

let currentMode: ThemeMode = usePreferences.getState().themeMode
let systemDark = false
let resolved: ResolvedTheme = 'light'

const listeners = new Set<() => void>()

function recompute() {
  resolved = currentMode === 'system' ? (systemDark ? 'dark' : 'light') : currentMode
}

function applyTheme() {
  document.documentElement.dataset.theme = resolved
}

if (typeof window !== 'undefined') {
  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  systemDark = mql.matches
  recompute()
  applyTheme()
  mql.addEventListener('change', (e) => {
    systemDark = e.matches
    recompute()
    applyTheme()
    emit()
  })
}

function emit() {
  for (const fn of listeners) fn()
}

// 偏好 store 变化 → 同步主题（setThemeMode 的唯一真源是 preferences）
let prevMode = currentMode
usePreferences.subscribe((s) => {
  if (s.themeMode !== prevMode) {
    prevMode = s.themeMode
    currentMode = s.themeMode
    recompute()
    applyTheme()
    emit()
  }
})

export function setThemeMode(mode: ThemeMode) {
  usePreferences.getState().setThemeMode(mode)
}

/** light → dark → system 循环（头部快捷按钮用） */
export function cycleThemeMode() {
  const i = THEME_MODES.indexOf(currentMode)
  setThemeMode(THEME_MODES[(i + 1) % THEME_MODES.length]!)
}

export function useTheme() {
  const mode = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => `${currentMode}:${resolved}`,
    () => 'system:light',
  )
  const [m, r] = mode.split(':') as [ThemeMode, ResolvedTheme]
  return { themeMode: m, resolvedTheme: r, setThemeMode, cycleThemeMode }
}

/** 供非组件代码（sonner Toaster 主题、厂商图标目录）读取当前解析主题 */
export function getResolvedTheme(): ResolvedTheme {
  return resolved
}
