/**
 * DesktopBootstrap — 桌面桥生命周期：
 * - 订阅迁移进度：done → 展示「完成」后刷新；error → 关遮罩（toast 由触发方提示）
 * - 启动 25s 后静默查询更新状态，available 时提示一次
 * 只注册一次；Effect cleanup 取消订阅与 timer（StrictMode 下注册→清理→注册无重复提示）。
 */
import { useEffect } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { getDesktopBridge } from '@/shared/desktop/bridge'
import { migrateOperations, migrateStore } from './migrate-store'

export function DesktopBootstrap() {
  const { t } = useTranslation()

  useEffect(() => {
    const bridge = getDesktopBridge()
    if (!bridge) return

    const unsubscribeMigrate = bridge.onMigrateProgress((p) => {
      if (p.phase === 'done') {
        migrateOperations.update(p)
        // 稍等遮罩展示「完成」，再刷新页面让所有数据源指向新目录
        setTimeout(() => {
          migrateOperations.end()
          location.reload()
        }, 800)
        return
      }
      if (p.phase === 'error') {
        migrateOperations.end()
        return
      }
      if (!migrateStore.getState().active) migrateOperations.begin()
      migrateOperations.update(p)
    })

    // 启动静默检查更新（主进程 20s 后自检一次，这里稍后取结果提示一次）
    const timer = setTimeout(async () => {
      try {
        const s = await bridge.getUpdateState()
        if (s?.status === 'available') {
          toast.info(t('app.updateAvailable', { version: s.latestVersion }), { duration: 8000 })
        }
      } catch {
        /* 静默 */
      }
    }, 25_000)

    return () => {
      unsubscribeMigrate()
      clearTimeout(timer)
    }
  }, [t])

  return null
}
