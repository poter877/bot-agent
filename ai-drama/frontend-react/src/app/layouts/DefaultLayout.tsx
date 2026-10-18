/**
 * DefaultLayout — 顶栏壳（品牌/导航/主题/语言）+ AI 配置缺失横幅 + 内容区。
 * 样式已迁移 Tailwind（旧 DefaultLayout.module.css 已删除）；`.nav-link` 纯类
 * 保留为引导锚点（tour: '.nav-link[href="/settings"]'）。
 */
import { useCallback, useEffect, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Github, LayoutGrid, Settings as SettingsIcon, TriangleAlert } from 'lucide-react'
import { aiConfigApi } from '@/entities/ai-config/model'
import { useUiLocale } from '@/shared/config/use-locale'
import { ThemeToggle } from '@/shared/ui/ThemeToggle'
import { LocaleSwitcher } from '@/shared/ui/LocaleSwitcher'
import brandLogo from '@/assets/brand-logo.png'

const SERVICE_TYPE_KEYS = {
  text: 'common.serviceType.text',
  image: 'common.serviceType.image',
  video: 'common.serviceType.video',
} as const

const navLinkClass =
  'nav-link flex items-center gap-1.5 min-h-8 px-4 rounded-pill text-[13px] font-semibold ' +
  'text-content-muted no-underline transition-all duration-150 ease-app leading-none ' +
  'hover:text-content focus-visible:outline-none focus-visible:shadow-focus'
const navLinkActiveClass = 'bg-seg-active text-content shadow-[0_1px_4px_rgba(0,0,0,0.1)]'

export function DefaultLayout() {
  const { t } = useTranslation()
  const locale = useUiLocale()
  const location = useLocation()
  const [showBrandImage, setShowBrandImage] = useState(true)
  const [missingConfigLabels, setMissingConfigLabels] = useState<string[]>([])

  const checkAiConfigs = useCallback(async () => {
    try {
      const configs = await aiConfigApi.list()
      const missing = (Object.keys(SERVICE_TYPE_KEYS) as Array<keyof typeof SERVICE_TYPE_KEYS>)
        .filter((type) => !configs.some((c) => c.serviceType === type && c.isActive))
        .map((type) => t(SERVICE_TYPE_KEYS[type]))
      setMissingConfigLabels(missing)
    } catch {
      /* 配置检查失败不阻塞页面 */
    }
  }, [t])

  useEffect(() => {
    void checkAiConfigs()
  }, [checkAiConfigs, location.pathname, locale])

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-app">
      <header className="relative z-10 flex h-[60px] shrink-0 items-center gap-8 border-b border-outline bg-header px-6 backdrop-blur-[20px] backdrop-saturate-[1.8]">
        <div className="flex items-center">
          <Link
            to="/"
            className="flex cursor-pointer items-center gap-[11px] rounded-control px-2 py-1 pl-1 no-underline transition-colors duration-150 ease-app hover:bg-hover-overlay focus-visible:outline-none focus-visible:shadow-focus"
          >
            <div className="flex size-8 items-center justify-center overflow-hidden rounded-[9px]">
              {showBrandImage ? (
                <img src={brandLogo} alt={t('app.title')} className="block size-7 object-contain" onError={() => setShowBrandImage(false)} />
              ) : (
                <span className="text-[15px] leading-none font-bold text-content">视</span>
              )}
            </div>
            <div className="flex flex-col items-start leading-[1.15]">
              <span className="bg-brand-gradient bg-clip-text text-[15px] font-bold tracking-[-0.01em] text-transparent">
                {t('app.title')}
              </span>
              <span className="mt-px text-[10px] font-normal tracking-[0.04em] text-content-subtle">Video Factory</span>
            </div>
          </Link>
        </div>

        <nav className="flex gap-0.5 rounded-pill bg-track p-[3px]">
          <Link to="/" className={`${navLinkClass}${location.pathname === '/' ? ` ${navLinkActiveClass}` : ''}`}>
            <LayoutGrid size={15} strokeWidth={1.8} />
            <span>{t('layout.nav.projects')}</span>
          </Link>
          <Link
            to="/settings"
            className={`${navLinkClass}${location.pathname === '/settings' ? ` ${navLinkActiveClass}` : ''}`}
          >
            <SettingsIcon size={15} strokeWidth={1.8} />
            <span>{t('layout.nav.settings')}</span>
          </Link>
        </nav>

        <div className="ml-auto flex items-center">
          <a
            className="flex size-8 items-center justify-center rounded-pill text-content-muted leading-none transition-all duration-150 ease-app hover:bg-hover-overlay hover:text-content focus-visible:outline-none focus-visible:shadow-focus"
            href="https://github.com/chatfire-AI/huobao-drama"
            target="_blank"
            rel="noopener"
            aria-label="GitHub"
            title="GitHub"
          >
            <Github size={15} strokeWidth={1.8} />
          </a>
          <ThemeToggle />
          <LocaleSwitcher />
        </div>
      </header>

      {missingConfigLabels.length > 0 && (
        <div className="relative z-[9] flex shrink-0 items-center gap-2 border-b border-warn-border bg-warn-bg px-6 py-2 text-[12.5px] text-warn-text">
          <TriangleAlert size={14} strokeWidth={1.8} />
          <span>{t('layout.banner.missing', { types: missingConfigLabels.join(t('common.listJoin')) })}</span>
          <Link
            to="/settings"
            className="ml-auto rounded-pill border border-warn-border px-2.5 py-0.5 text-[12.5px] leading-[1.6] font-semibold text-warn-link no-underline transition-all duration-150 ease-app hover:bg-warn-link-hover-bg hover:text-warn-text"
          >
            {t('layout.banner.goSettings')}
          </Link>
        </div>
      )}

      <main className="flex flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>
    </div>
  )
}
