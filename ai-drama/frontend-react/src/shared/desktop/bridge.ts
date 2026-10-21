/**
 * 桌面版桥类型声明与安全取值。
 *
 * 注：曾用名 window.huobaoDesktop 在现桌面 preload 中从未注入——
 * 本桥长期返回 null，更新/存储面板的桌面增强走降级路径。
 * 非桌面环境（浏览器/服务器部署）返回 null，UI 据此隐藏桌面专属功能。
 */

export interface UpdateState {
  status: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error'
  currentVersion: string
  latestVersion?: string
  notes?: string
  error?: string
  downloadProgress?: number
  downloadedFile?: string
}

export interface MigrateProgress {
  phase: string
  message?: string
  copiedBytes?: number
  totalBytes?: number
}

export interface DesktopBridge {
  pickDirectory: () => Promise<{ ok: boolean; path?: string; freeBytes?: number | null; error?: string; canceled?: boolean }>
  startMigration: (opts: { targetDir: string; migrateFiles: boolean }) => Promise<{ ok: boolean }>
  onMigrateProgress: (cb: (progress: MigrateProgress) => void) => () => void
  getUpdateState: () => Promise<UpdateState>
  checkUpdate: () => Promise<UpdateState>
  downloadUpdate: () => Promise<UpdateState>
  applyUpdate: () => Promise<void>
  onUpdateProgress: (cb: (percent: number) => void) => () => void
}

export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as { desktopBridge?: DesktopBridge }).desktopBridge ?? null
}

/** 组件内取桥（保持旧 useDesktopBridge 调用形态） */
export function useDesktopBridge(): DesktopBridge | null {
  return getDesktopBridge()
}
