/**
 * 全局偏好 store（Zustand persist）— 主题、界面语言、侧栏折叠、工作台栏宽、
 * 模型选择与工作台面板记忆。只持久化低敏偏好；模型配置实体与 API Key 不入内。
 *
 * 存储格式：新键 huobao:prefs:v1（带 version 的 JSON），首次启动时从旧前端的
 * 逐键纯字符串格式迁移种子（huobao:theme、huobao:locale、huobao:sidebar-collapsed、
 * huobao:workbench:video-cols、huobao:model:[chat,image,video]、huobao:workbench:panel 等）。
 * 旧键保留不删，支持回退旧前端后偏好不丢。
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type ThemeMode = 'light' | 'dark' | 'system'
export type UiLocale = 'zh' | 'en' | 'ja' | 'ko'

export interface VideoColumns {
  left: number
  right: number
}

/** 工作台面板记忆：按 dramaId:episodeNumber 隔离，仅整页 reload 时恢复 */
export interface PanelMemory {
  panel: 'script' | 'production' | 'export'
  scriptStep: number
  prodTab: 'assets' | 'videos'
}

export type ModelKind = 'chat' | 'image' | 'video'

interface PreferencesState {
  themeMode: ThemeMode
  uiLocale: UiLocale
  sidebarCollapsed: boolean
  videoColumns: VideoColumns
  modelPrefs: Record<ModelKind, string>
  panels: Record<string, PanelMemory>
  setThemeMode: (mode: ThemeMode) => void
  setUiLocale: (locale: UiLocale) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setVideoColumns: (cols: VideoColumns) => void
  setModelPref: (kind: ModelKind, value: string) => void
  setPanelMemory: (key: string, memory: PanelMemory) => void
}

export const PREFS_STORAGE_KEY = 'huobao:prefs:v1'

/** 实际持久化的字段子集（不含 action） */
interface PersistedPrefs {
  themeMode: ThemeMode
  uiLocale: UiLocale
  sidebarCollapsed: boolean
  videoColumns: VideoColumns
  modelPrefs: Record<ModelKind, string>
  panels: Record<string, PanelMemory>
}

const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system']
const UI_LOCALE_VALUES: UiLocale[] = ['zh', 'en', 'ja', 'ko']

function readString(key: string): string {
  try {
    return localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

/** 从旧前端逐键格式合成初始偏好（仅在新存储不存在时执行一次；导出供迁移契约测试） */
export function seedFromLegacy(): Partial<PreferencesState> | null {
  if (typeof localStorage === 'undefined') return null
  const seeded: Partial<PreferencesState> = {}

  const theme = readString('huobao:theme') as ThemeMode
  if (THEME_MODES.includes(theme)) seeded.themeMode = theme

  const locale = readString('huobao:locale') as UiLocale
  if (UI_LOCALE_VALUES.includes(locale)) seeded.uiLocale = locale

  seeded.sidebarCollapsed = readString('huobao:sidebar-collapsed') === '1'

  const cols = readJson<VideoColumns>('huobao:workbench:video-cols')
  if (cols && typeof cols.left === 'number' && typeof cols.right === 'number') {
    seeded.videoColumns = { left: cols.left, right: cols.right }
  }

  const modelPrefs: Record<ModelKind, string> = { chat: '', image: '', video: '' }
  modelPrefs.chat = readString('huobao:model:chat') || readString('huobao:model:rewrite')
  modelPrefs.image = readString('huobao:model:image')
  modelPrefs.video = readString('huobao:model:video')
  seeded.modelPrefs = modelPrefs

  const panels: Record<string, PanelMemory> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith('huobao:workbench:panel:')) continue
    const mem = readJson<PanelMemory>(key)
    if (mem && ['script', 'production', 'export'].includes(mem.panel)) {
      panels[key.replace('huobao:workbench:panel:', '')] = mem
    }
  }
  seeded.panels = panels
  return seeded
}

const legacyStorage = createJSONStorage<PersistedPrefs>(() => {
  const real = typeof localStorage === 'undefined' ? undefined : localStorage
  return {
    getItem: (name) => {
      const existing = real?.getItem(name) ?? null
      if (existing) return existing
      // 新键不存在：用旧键合成一份持久化快照，交给 persist 的 version/migrate 管线
      const seeded = seedFromLegacy()
      if (!seeded) return null
      return JSON.stringify({ state: seeded, version: 0 })
    },
    setItem: (name, value) => real?.setItem(name, value),
    removeItem: (name) => real?.removeItem(name),
  }
})

export const usePreferences = create<PreferencesState>()(
  persist<PreferencesState, [], [], PersistedPrefs>(
    (set) => ({
      themeMode: 'system',
      uiLocale: 'zh',
      sidebarCollapsed: false,
      videoColumns: { left: 300, right: 380 },
      modelPrefs: { chat: '', image: '', video: '' },
      panels: {},
      setThemeMode: (mode) => set({ themeMode: mode }),
      setUiLocale: (locale) => set({ uiLocale: locale }),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setVideoColumns: (cols) => set({ videoColumns: cols }),
      setModelPref: (kind, value) =>
        set((s) => ({ modelPrefs: { ...s.modelPrefs, [kind]: value } })),
      setPanelMemory: (key, memory) =>
        set((s) => ({ panels: { ...s.panels, [key]: memory } })),
    }),
    {
      name: PREFS_STORAGE_KEY,
      version: 1,
      storage: legacyStorage,
      partialize: (s): PersistedPrefs => ({
        themeMode: s.themeMode,
        uiLocale: s.uiLocale,
        sidebarCollapsed: s.sidebarCollapsed,
        videoColumns: s.videoColumns,
        modelPrefs: s.modelPrefs,
        panels: s.panels,
      }),
      migrate: (persisted): PersistedPrefs => {
        const p = (persisted ?? {}) as Partial<PersistedPrefs>
        return {
          themeMode: THEME_MODES.includes(p.themeMode as ThemeMode) ? p.themeMode! : 'system',
          uiLocale: UI_LOCALE_VALUES.includes(p.uiLocale as UiLocale) ? p.uiLocale! : 'zh',
          sidebarCollapsed: !!p.sidebarCollapsed,
          videoColumns:
            p.videoColumns && typeof p.videoColumns.left === 'number'
              ? p.videoColumns
              : { left: 300, right: 380 },
          modelPrefs: {
            chat: p.modelPrefs?.chat ?? '',
            image: p.modelPrefs?.image ?? '',
            video: p.modelPrefs?.video ?? '',
          },
          panels: p.panels ?? {},
        }
      },
    },
  ),
)
