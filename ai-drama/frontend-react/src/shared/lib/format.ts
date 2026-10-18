/** 相对时间与字节格式化（渲染时经 i18n 求值，语言切换即时生效） */
import { t, i18next } from '@/shared/config/i18n'

export function relativeTime(iso: string | undefined | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return t('index.time.justNow')
  if (diff < 3_600_000) return t('index.time.minutesAgo', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('index.time.hoursAgo', { n: Math.floor(diff / 3_600_000) })
  if (diff < 604_800_000) return t('index.time.daysAgo', { n: Math.floor(diff / 86_400_000) })
  const locale = i18next.language === 'zh' ? 'zh-CN' : i18next.language
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

/** 绝对日期时间（任务历史等） */
export function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString()
}

/** 秒数 → "x 分 y 秒" 简洁展示（时长参数卡等） */
export function formatDurationSeconds(total: number): string {
  const m = Math.floor(total / 60)
  const s = Math.round(total % 60)
  if (m <= 0) return `${s}s`
  return `${m}m${s ? ` ${s}s` : ''}`
}
