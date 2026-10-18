/**
 * 存储迁移全局状态（Zustand vanilla store）。
 * MigrationOverlay 据此渲染全屏遮罩；迁移由设置页触发，进度经桌面桥订阅回填。
 */
import { createStore } from 'zustand/vanilla'
import { t } from '@/shared/config/i18n'

export interface MigrateState {
  active: boolean
  phase: string
  percent: number
  message: string
}

export const migrateStore = createStore<MigrateState>(() => ({
  active: false,
  phase: '',
  percent: 0,
  message: '',
}))

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

// 渲染/调用时经 i18n 求值，语言切换即时生效（不能模块级常量固化）
function phaseText(phase: string): string {
  const keys: Record<string, string> = {
    validating: 'migrate.phases.validating',
    stopping: 'migrate.phases.stopping',
    moving: 'migrate.phases.moving',
    config: 'migrate.phases.config',
    restarting: 'migrate.phases.restarting',
    done: 'migrate.phases.done',
    error: 'migrate.phases.error',
  }
  const key = keys[phase]
  return key ? t(key) : phase
}

export const migrateOperations = {
  begin() {
    migrateStore.setState({
      active: true,
      phase: 'validating',
      percent: 0,
      message: phaseText('validating'),
    })
  },

  update(p: { phase: string; message?: string; copiedBytes?: number; totalBytes?: number }) {
    if (p.phase === 'moving' && p.totalBytes) {
      migrateStore.setState({
        phase: p.phase,
        percent: Math.min(99, Math.round(((p.copiedBytes ?? 0) / p.totalBytes) * 100)),
        message: t('migrate.phases.movingProgress', {
          copied: formatBytes(p.copiedBytes ?? 0),
          total: formatBytes(p.totalBytes),
        }),
      })
    } else {
      migrateStore.setState({
        phase: p.phase,
        message: p.message || phaseText(p.phase),
        ...(p.phase === 'done' ? { percent: 100 } : {}),
      })
    }
  },

  end() {
    migrateStore.setState({ active: false })
  },
}
