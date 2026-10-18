/** 通用面板：AI 内容语言（统一语言切换入口）+ 外观主题 */
import { useTranslation } from 'react-i18next'
import { Languages, SunMoon } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { qk } from '@/shared/api/query-keys'
import { settingsApi } from '@/entities/settings/api'
import { confirmUnifiedLanguage } from '@/features/preferences/language-service'
import { useTheme } from '@/shared/config/theme'
import type { UiLocale } from '@/shared/config/preferences'
import { cardVariants } from '@/shared/ui/card'
import { cn } from '@/shared/lib/cn'

const CONTENT_LANGS: { value: UiLocale; label: string }[] = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
]

// settings-scroll 直接子元素限宽居中；card + card 间距 14px
const PANEL_SCROLL = 'h-full overflow-y-auto px-7 pt-5 pb-12 animate-fade-up'
const CONTENT_W = 'mx-auto w-full max-w-[1080px]'
const SETTINGS_HEAD = `${CONTENT_W} mb-5`
const SETTINGS_TITLE = 'text-[22px] font-extrabold tracking-[-0.02em]'
const SETTINGS_DESC = 'mt-1.5 text-[13px] text-content-muted'
const SVC_GROUP = 'overflow-hidden'
const SVC_GROUP_HEAD = 'flex items-center gap-2.5 border-b border-outline px-5 py-3.5'
const SVC_GROUP_HEADING = 'min-w-0'
const SVC_GROUP_TITLE = 'text-body font-bold text-content'
const SVC_GROUP_SUB = 'mt-0.5 text-[11.5px] text-content-subtle'
const CONFIG_ROW = 'flex items-center gap-3 px-5 py-3'
const PROVIDER_BADGE =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-brand text-[14px] font-bold text-on-action shadow-[0_1px_4px_rgba(0,0,0,0.12)]'
const CONFIG_MAIN = 'flex min-w-0 flex-1 flex-col gap-[3px]'
const CONFIG_LINE = 'flex min-w-0 items-center gap-2'
const CONFIG_NAME = 'text-form font-[650] text-content'
const CONFIG_SUB = 'text-[11.5px] text-content-subtle'
const LANG_PICKER = 'flex gap-0.5 rounded-pill bg-track p-[3px]'
const LANG_OPTION_BASE =
  'min-h-[30px] cursor-pointer whitespace-nowrap rounded-pill border-none bg-transparent px-3.5 py-0 text-[12.5px] font-semibold leading-none transition-all duration-[160ms] ease-app focus-visible:outline-none focus-visible:shadow-focus'
const LANG_OPTION_ON = 'bg-seg-active text-content shadow-[0_1px_4px_rgba(0,0,0,0.1)]'
const LANG_OPTION_IDLE = 'text-content-muted hover:text-content'
const CONFIG_EMPTY = 'px-5 py-3.5 text-[12px] text-content-subtle'

export function GeneralPanel() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { themeMode, setThemeMode } = useTheme()

  const langQuery = useQuery({
    queryKey: qk.contentLanguage(),
    queryFn: ({ signal }) => settingsApi.contentLanguage(signal),
    staleTime: 30_000,
  })
  const contentLanguage = langQuery.data?.language || 'zh'

  const themeOptions = [
    { value: 'light' as const, label: t('settings.general.appearanceLight') },
    { value: 'dark' as const, label: t('settings.general.appearanceDark') },
    { value: 'system' as const, label: t('settings.general.appearanceSystem') },
  ]

  function setContentLanguage(lang: UiLocale) {
    if (contentLanguage === lang) return
    // UI 语言 = AI 内容语言：确认弹窗 → 统一切换 → 刷新（顶栏 LocaleSwitcher 同一入口）
    void confirmUnifiedLanguage(lang)
    void queryClient
  }

  return (
    <div className={PANEL_SCROLL}>
      <div className={SETTINGS_HEAD}>
        <h2 className={SETTINGS_TITLE}>{t('settings.general.title')}</h2>
        <p className={SETTINGS_DESC}>{t('settings.general.desc')}</p>
      </div>
      <section className={cn(cardVariants(), CONTENT_W, SVC_GROUP)}>
        <div className={SVC_GROUP_HEAD}>
          <div className={SVC_GROUP_HEADING}>
            <span className={SVC_GROUP_TITLE}>{t('settings.general.contentLanguage')}</span>
            <div className={SVC_GROUP_SUB}>{t('settings.general.contentLanguageSub')}</div>
          </div>
        </div>
        <div className={CONFIG_ROW}>
          <div className={PROVIDER_BADGE} style={{ background: 'var(--hb-brand-soft)', color: 'var(--hb-brand)' }}>
            <Languages size={15} />
          </div>
          <div className={CONFIG_MAIN}>
            <div className={CONFIG_LINE}>
              <span className={CONFIG_NAME}>{t('settings.general.languageLabel')}</span>
            </div>
            <div className={CONFIG_SUB}>{t('settings.general.languageNote')}</div>
          </div>
          <div className={LANG_PICKER}>
            {CONTENT_LANGS.map((l) => (
              <button
                key={l.value}
                type="button"
                className={cn(LANG_OPTION_BASE, contentLanguage === l.value ? LANG_OPTION_ON : LANG_OPTION_IDLE)}
                onClick={() => setContentLanguage(l.value)}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>
        <p className={CONFIG_EMPTY}>{t('settings.general.languageHint')}</p>
      </section>

      {/* 外观主题 */}
      <section className={cn(cardVariants(), CONTENT_W, 'mt-3.5', SVC_GROUP)}>
        <div className={SVC_GROUP_HEAD}>
          <div className={SVC_GROUP_HEADING}>
            <span className={SVC_GROUP_TITLE}>{t('settings.general.appearance')}</span>
            <div className={SVC_GROUP_SUB}>{t('settings.general.appearanceSub')}</div>
          </div>
        </div>
        <div className={CONFIG_ROW}>
          <div className={PROVIDER_BADGE} style={{ background: 'var(--hb-brand-soft)', color: 'var(--hb-brand)' }}>
            <SunMoon size={15} />
          </div>
          <div className={CONFIG_MAIN}>
            <div className={CONFIG_LINE}>
              <span className={CONFIG_NAME}>{t('settings.general.appearanceLabel')}</span>
            </div>
            <div className={CONFIG_SUB}>{t('settings.general.appearanceNote')}</div>
          </div>
          <div className={LANG_PICKER}>
            {themeOptions.map((o) => (
              <button
                key={o.value}
                type="button"
                className={cn(LANG_OPTION_BASE, themeMode === o.value ? LANG_OPTION_ON : LANG_OPTION_IDLE)}
                onClick={() => setThemeMode(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}
