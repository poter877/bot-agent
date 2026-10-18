/**
 * i18n（i18next + react-i18next）— 四语言词库与偏好持久化。
 * - {name} 命名插值由 interpolation.prefix/suffix 解析
 * - 词库中的 {'@'} 字面量转义已在复制时还原为 @
 * - keySeparator '.' 解析嵌套 JSON；默认回退中文
 * - escapeValue false：React 渲染默认转义，无需二次处理
 */
import i18next, { type i18n as I18nInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@/shared/locales/zh.json'
import en from '@/shared/locales/en.json'
import ja from '@/shared/locales/ja.json'
import ko from '@/shared/locales/ko.json'
import { usePreferences, type UiLocale } from './preferences'

export const LOCALE_STORAGE_KEY = 'huobao:locale'

export type { UiLocale }

export const UI_LOCALES: Array<{ value: UiLocale; label: string }> = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
]

export function readStoredLocale(): UiLocale {
  try {
    const v = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (v && UI_LOCALES.some((l) => l.value === v)) return v as UiLocale
  } catch {
    /* localStorage 不可用时回退默认 */
  }
  return 'zh'
}

export function persistLocale(locale: UiLocale) {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    /* 忽略持久化失败 */
  }
}

let initialized = false

export { i18next }

export function initI18n(): I18nInstance {
  if (initialized) return i18next
  initialized = true
  void i18next.use(initReactI18next).init({
    resources: {
      zh: { translation: zh },
      en: { translation: en },
      ja: { translation: ja },
      ko: { translation: ko },
    },
    lng: usePreferences.getState().uiLocale,
    fallbackLng: 'zh',
    interpolation: { escapeValue: false, prefix: '{', suffix: '}' },
    returnNull: false,
  })
  return i18next
}

/** 切换 UI 语言并持久化（LocaleSwitcher/设置页与初始化共用） */
export function setUiLocale(locale: UiLocale) {
  void i18next.changeLanguage(locale)
  usePreferences.getState().setUiLocale(locale)
  persistLocale(locale)
  document.documentElement.lang = { zh: 'zh-CN', en: 'en', ja: 'ja', ko: 'ko' }[locale] ?? 'zh-CN'
}

/** 非组件代码（composable 服务层）取文案 */
export function t(key: string, params?: Record<string, unknown>): string {
  return i18next.t(key, params ?? {})
}
