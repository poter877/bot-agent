/**
 * 统一语言切换服务：UI 语言 = AI 内容语言，同一个开关。
 *
 * 流程（对旧行为的修正项：旧版取消与确认都会 resolve(true)）：
 * 1. 弹独立确认弹窗（LanguageSwitchHost 渲染），显式 resolve(false/true)
 * 2. 确认后：写后端 content_language → 切 UI locale → 短暂提示 → location.reload()
 */
import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { setUiLocale, t, type UiLocale } from '@/shared/config/i18n'
import { settingsApi } from '@/entities/settings/api'

interface PendingRequest {
  lang: UiLocale
}

let pending: PendingRequest | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const fn of listeners) fn()
}

/** 弹确认框；resolve(true) = 用户确认切换，false = 取消（不写任何设置） */
function requestLanguageConfirm(lang: UiLocale): Promise<boolean> {
  return new Promise((resolve) => {
    pending = { lang }
    emit()
    pendingResolvers.push(resolve)
  })
}

const pendingResolvers: Array<(ok: boolean) => void> = []

/** Host 组件回调：显式关闭并返回结果 */
export function resolveLanguageConfirm(ok: boolean) {
  const resolve = pendingResolvers.shift()
  pending = null
  emit()
  resolve?.(ok)
}

export function useLanguageConfirmRequest(): PendingRequest | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => pending,
    () => null,
  )
}

let switching = false

/** 入口：先弹确认框，确认后执行统一切换并刷新 */
export async function confirmUnifiedLanguage(lang: UiLocale) {
  if (switching) return
  const ok = await requestLanguageConfirm(lang)
  if (!ok) return
  switching = true
  try {
    await settingsApi.setContentLanguage(lang)
  } catch {
    /* 后端失败不阻断界面切换 */
  }
  setUiLocale(lang)
  try {
    toast.info(t('components.langSwitch.refreshing'), { duration: 1200 })
  } catch {
    /* 提示失败不阻断 */
  }
  setTimeout(() => location.reload(), 1000)
}
