/**
 * 设置页壳：左侧导航 + 右侧面板。
 * 各面板独立挂载（切到对应 tab 才请求数据）；内容语言由 agents 面板经共享缓存读取。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Cpu, HardDrive, Languages, Palette, RefreshCw } from 'lucide-react'
import { GeneralPanel } from './panels/GeneralPanel'
import { AiConfigsPanel } from './panels/AiConfigsPanel'
import { StylePresetsPanel } from './panels/StylePresetsPanel'
import { AgentsPanel } from './panels/AgentsPanel'
import { StoragePanel } from './panels/StoragePanel'
import { UpdatePanel } from './panels/UpdatePanel'
import { autoTour, startTour, type TourStep } from '@/shared/lib/tour'
import { Button } from '@/shared/ui/button'
import { cn } from '@/shared/lib/cn'

const SETTINGS_TOUR: TourStep[] = [
  { element: '.quick-card', titleKey: 'tour.settings.quick.title', descKey: 'tour.settings.quick.desc', popoverSide: 'bottom' },
  { element: '.settings-nav .nav-item', titleKey: 'tour.settings.nav.title', descKey: 'tour.settings.nav.desc', popoverSide: 'right' },
]

type TabId = 'ai' | 'general' | 'styles' | 'agents' | 'storage' | 'about'

// settings-nav / nav-item / active 为引导与自动化锚点类，原样保留
const SETTINGS_PAGE = 'flex h-full flex-col bg-app'
const SETTINGS_LAYOUT = 'flex min-h-0 flex-1'
const SETTINGS_NAV = 'settings-nav flex w-[220px] shrink-0 flex-col gap-3.5 border-r border-outline px-3 py-4'
const NAV_GROUP = 'flex flex-col gap-0.5'
const NAV_GROUP_LABEL = 'px-3 pb-1 pt-2 text-[11px] font-[650] tracking-[0.06em] text-content-subtle'
const NAV_ITEM =
  'nav-item flex w-full cursor-pointer items-center gap-2 rounded-control border-none bg-transparent px-3 py-2 text-left text-[13px] transition-all duration-[160ms] ease-app focus-visible:outline-none focus-visible:shadow-focus'
const NAV_ITEM_ACTIVE = 'font-[650] bg-brand-soft text-brand-content active'
const NAV_ITEM_IDLE = 'font-[550] text-content-secondary hover:bg-hover-overlay hover:text-content'
const SETTINGS_CONTENT = 'min-h-0 min-w-0 flex-1 overflow-hidden'

export function SettingsPage() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<TabId>('ai')

  const baseTabs: { id: TabId; label: string; icon: typeof Cpu }[] = [
    { id: 'ai', label: '模型与服务', icon: Cpu },
    { id: 'general', label: t('settings.tabs.general'), icon: Languages },
    { id: 'styles', label: t('settings.tabs.styles'), icon: Palette },
    { id: 'agents', label: t('settings.tabs.agents'), icon: Bot },
    { id: 'storage', label: t('settings.tabs.storage'), icon: HardDrive },
    { id: 'about', label: t('settings.tabs.about'), icon: RefreshCw },
  ]

  useEffect(() => {
    const timer = setTimeout(() => autoTour('settings', SETTINGS_TOUR), 800)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div className={SETTINGS_PAGE}>
      <div className={SETTINGS_LAYOUT}>
        <aside className={SETTINGS_NAV}>
          <div className={NAV_GROUP}>
            <div className={NAV_GROUP_LABEL}>{t('settings.groupBase')}</div>
            {baseTabs.map((nt) => {
              const Icon = nt.icon
              return (
                <button
                  key={nt.id}
                  type="button"
                  className={cn(NAV_ITEM, tab === nt.id ? NAV_ITEM_ACTIVE : NAV_ITEM_IDLE)}
                  onClick={() => setTab(nt.id)}
                >
                  <Icon size={14} />
                  {nt.label}
                </button>
              )
            })}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="mx-3 w-fit"
            onClick={() => startTour('settings', SETTINGS_TOUR)}
          >
            {t('tour.helpTitle')}
          </Button>
        </aside>

        <div className={SETTINGS_CONTENT}>
          {tab === 'general' && <GeneralPanel />}
          {tab === 'ai' && <AiConfigsPanel />}
          {tab === 'styles' && <StylePresetsPanel />}
          {tab === 'agents' && <AgentsPanel />}
          {tab === 'storage' && <StoragePanel />}
          {tab === 'about' && <UpdatePanel />}
        </div>
      </div>
    </div>
  )
}
