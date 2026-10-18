/** 存储迁移全屏遮罩：spinner + 进度条 + phase 文案（样式已迁移 Tailwind） */
import { useTranslation } from 'react-i18next'
import { useSyncExternalStore } from 'react'
import { Loader2 } from 'lucide-react'
import { createPortal } from 'react-dom'
import { migrateStore } from './migrate-store'

export function MigrationOverlay() {
  const { t } = useTranslation()
  const state = useSyncExternalStore(migrateStore.subscribe, migrateStore.getState, migrateStore.getState)

  if (!state.active) return null
  return createPortal(
    <div className="fixed inset-0 z-[var(--hb-z-blocking)] flex items-center justify-center bg-[rgba(8,10,14,0.72)] backdrop-blur-[4px]">
      <div className="flex w-[380px] flex-col items-center gap-3 rounded-xl border border-outline bg-surface px-8 py-7 text-content shadow-dialog">
        <Loader2 size={26} className="animate-spin" />
        <div className="text-[15px] font-semibold">{t('migrate.title')}</div>
        <div className="min-h-4 text-xs text-content-muted">{state.message}</div>
        <div className="h-1.5 w-full overflow-hidden rounded-[3px] bg-track">
          <div className="h-full rounded-[3px] bg-brand transition-[width] duration-200 ease-app" style={{ width: `${state.percent}%` }} />
        </div>
        <div className="text-micro text-content-subtle">{t('migrate.hint')}</div>
      </div>
    </div>,
    document.body,
  )
}
