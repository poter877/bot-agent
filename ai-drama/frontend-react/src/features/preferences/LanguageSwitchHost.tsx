/** 全局挂载的语言切换确认弹窗宿主（AppProviders 内常驻） */
import { useTranslation } from 'react-i18next'
import { LanguageSwitchDialog } from '@/shared/ui/LanguageSwitchDialog'
import { resolveLanguageConfirm, useLanguageConfirmRequest } from './language-service'

const LANG_NAME_KEYS: Record<string, string> = {
  zh: 'settings.general.langNameZh',
  en: 'settings.general.langNameEn',
  ja: 'settings.general.langNameJa',
  ko: 'settings.general.langNameKo',
}

export function LanguageSwitchHost() {
  const { t } = useTranslation()
  const request = useLanguageConfirmRequest()

  if (!request) return null
  const langName = t(LANG_NAME_KEYS[request.lang] ?? LANG_NAME_KEYS.zh!)
  return (
    <LanguageSwitchDialog
      open
      title={t('components.langSwitch.title', { lang: langName })}
      message={t('components.langSwitch.message')}
      onConfirm={() => resolveLanguageConfirm(true)}
      onCancel={() => resolveLanguageConfirm(false)}
    />
  )
}
