/** 顶栏主题循环按钮（light → dark → system），图标显示当前模式 */
import { Sun, Moon, Monitor } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/shared/config/theme'

export function ThemeToggle() {
  const { t } = useTranslation()
  const { themeMode, cycleThemeMode } = useTheme()
  const Icon = themeMode === 'light' ? Sun : themeMode === 'dark' ? Moon : Monitor
  return (
    <button
      type="button"
      className="flex size-8 cursor-pointer items-center justify-center rounded-pill border-none bg-transparent leading-none text-content-muted transition-all duration-150 ease-app hover:bg-hover-overlay hover:text-content focus-visible:outline-none focus-visible:shadow-focus"
      aria-label={t('layout.theme.label')}
      title={t(`layout.theme.${themeMode}`)}
      onClick={cycleThemeMode}
    >
      <Icon size={15} strokeWidth={1.8} />
    </button>
  )
}
