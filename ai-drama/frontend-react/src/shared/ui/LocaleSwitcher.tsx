/** 顶栏语言切换按钮：选择即走统一确认+刷新流程 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Languages } from 'lucide-react'
import { AppMenu } from './AppMenu'
import { AppMenuItem } from './AppMenuItem'
import { UI_LOCALES } from '@/shared/config/i18n'
import { useUiLocale } from '@/shared/config/use-locale'
import { confirmUnifiedLanguage } from '@/features/preferences/language-service'

export function LocaleSwitcher() {
  const { t } = useTranslation()
  const locale = useUiLocale()
  const [open, setOpen] = useState(false)
  const currentLabel = UI_LOCALES.find((l) => l.value === locale)?.label || locale

  function select(l: (typeof UI_LOCALES)[number]['value']) {
    // UI 语言 = AI 内容语言：确认弹窗 → 统一切换 → 刷新界面
    void confirmUnifiedLanguage(l)
    setOpen(false)
  }

  return (
    <AppMenu
      open={open}
      onOpenChange={setOpen}
      placement="bottom-end"
      minWidth={140}
      trigger={() => (
        <button
          type="button"
          className="flex min-h-8 cursor-pointer items-center gap-1.5 rounded-pill border-none bg-transparent px-3 text-[13px] font-semibold leading-none text-content-muted transition-all duration-150 ease-app hover:bg-hover-overlay hover:text-content focus-visible:outline-none focus-visible:shadow-focus"
          aria-label={t('components.localeSwitcher.label')}
        >
          <Languages size={15} strokeWidth={1.8} />
          <span className="max-w-[88px] overflow-hidden text-ellipsis whitespace-nowrap">{currentLabel}</span>
        </button>
      )}
    >
      {UI_LOCALES.map((l) => (
        <AppMenuItem key={l.value} selected={l.value === locale} onClick={() => select(l.value)}>
          {l.label}
        </AppMenuItem>
      ))}
    </AppMenu>
  )
}
