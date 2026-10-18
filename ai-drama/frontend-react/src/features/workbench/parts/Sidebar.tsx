/**
 * 工作台左栏：三段步骤树 + 收起/展开 + 四段主流程跑马灯 + 刷新。
 * 样式已迁移 Tailwind。局部例外：`pipeSectionPulse` / `seg-marquee` 关键帧随本组件
 * 内联 <style> 输出（原 CSS Modules 删除后无全局宿主），仅服务本文件的步骤脉冲点
 * 与跑马灯流动光效。
 */
import { useTranslation } from 'react-i18next'
import { Clapperboard, Download, FileText, Users } from 'lucide-react'
import { useWorkbench } from '../WorkbenchProvider'
import { useWorkbenchStore } from '../workbench-store'
import { usePreferences } from '@/shared/config/preferences'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/shared/lib/cn'

interface SidebarItem {
  key: string
  label: string
  icon: LucideIcon
}

/* 原 @keyframes pipeSectionPulse / seg-marquee（局部例外，见文件头注释） */
const SIDEBAR_KEYFRAMES = [
  '@keyframes pipeSectionPulse{0%{box-shadow:0 0 0 0 var(--hb-brand-glow)}70%{box-shadow:0 0 0 5px transparent}100%{box-shadow:0 0 0 0 transparent}}',
  '@keyframes seg-marquee{from{background-position:220% 0}to{background-position:-220% 0}}',
].join('')

const pulseClass = 'animate-[pipeSectionPulse_1.6s_var(--hb-ease-out)_infinite]'

export function WorkbenchSidebar() {
  const { t } = useTranslation()
  const wb = useWorkbench()
  const stage = useWorkbenchStore((s) => s.stage)
  const scriptStep = useWorkbenchStore((s) => s.scriptStep)
  const prodTab = useWorkbenchStore((s) => s.prodTab)
  const goSubStep = useGoSubStep()
  const goMainStage = useGoMainStage()
  const sidebarCollapsed = usePreferences((s) => s.sidebarCollapsed)
  const setSidebarCollapsed = usePreferences((s) => s.setSidebarCollapsed)

  const scriptDone = !!wb.episode?.scriptContent
  const assetTotal = wb.visualChars.length + wb.scenes.length + wb.props.length
  const assetReady =
    wb.visualChars.filter((c) => c.imageUrl).length +
    wb.scenes.filter((s) => s.imageUrl).length +
    wb.props.filter((p) => p.imageUrl).length
  const assetsDone = assetTotal > 0 && assetReady === assetTotal
  const shotVidCount = wb.sbs.filter((s) => !!(s.videoUrl || s.composedVideoUrl)).length
  const videosDone = wb.sbs.length > 0 && shotVidCount === wb.sbs.length
  const exportDone = wb.episode?.status === 'completed'

  const sections: { id: string; label: string; items: SidebarItem[] }[] = [
    {
      id: 'script',
      label: t('episode.stage.script'),
      items: [
        { key: 'script:raw', label: t('episode.script.raw'), icon: FileText },
        { key: 'script:rewrite', label: t('episode.script.rewrite'), icon: FileText },
      ],
    },
    {
      id: 'production',
      label: t('episode.stage.production'),
      items: [
        { key: 'prod:assets', label: t('episode.prod.assets'), icon: Users },
        { key: 'prod:videos', label: t('episode.prod.videos'), icon: Clapperboard },
      ],
    },
    {
      id: 'export',
      label: t('episode.stage.export'),
      items: [{ key: 'export:merge', label: t('episode.stage.mergeExport'), icon: Download }],
    },
  ]

  const sectionState = (id: string): 'done' | 'active' | 'pending' | 'none' => {
    if (id === 'export') return 'none'
    const done = id === 'script' ? scriptDone : assetsDone && videosDone
    if (done) return 'done'
    const hasProgress =
      id === 'script'
        ? !!(wb.rawDraft || wb.episode?.scriptContent)
        : !!(wb.chars.length || wb.scenes.length || wb.props.length || wb.sbs.length || shotVidCount)
    const isCurrent = id === 'script' ? stage === 'script' : stage === 'production'
    return hasProgress || isCurrent ? 'active' : 'pending'
  }

  const activeSubStepKey =
    stage === 'script' ? (scriptStep === 0 ? 'script:raw' : 'script:rewrite') : stage === 'production' ? `prod:${prodTab}` : 'export:merge'

  const mainProgressSteps = [
    { id: 'script', label: t('episode.stage.script') },
    { id: 'assets', label: t('episode.prod.assets') },
    { id: 'videos', label: t('episode.stage.videos') },
    { id: 'export', label: t('episode.stage.export') },
  ]
  const activeMainStage =
    stage === 'export' ? 'export' : stage === 'production' ? (prodTab === 'assets' ? 'assets' : 'videos') : 'script'
  const currentMainIdx = Math.max(
    0,
    mainProgressSteps.findIndex((s) => s.id === activeMainStage),
  )
  const mainStageDone = (id: string) =>
    id === 'script' ? scriptDone : id === 'assets' ? assetsDone : id === 'videos' ? videosDone : exportDone

  const currentStageLabel =
    stage === 'script'
      ? t('episode.stage.scriptStage', { step: scriptStep === 0 ? t('episode.script.raw') : t('episode.script.rewrite') })
      : stage === 'production'
        ? t('episode.stage.prodStage', { step: prodTab === 'assets' ? t('episode.prod.assets') : t('episode.prod.videos') })
        : exportDone
          ? t('episode.stage.exportDone')
          : t('episode.stage.exportWaiting')

  return (
    <>
      <style>{SIDEBAR_KEYFRAMES}</style>
      <aside
        className={cn(
          'flex w-[208px] shrink-0 flex-col overflow-hidden min-h-0 rounded-control border border-outline bg-surface shadow-card max-860:max-h-[340px] transition-[width] duration-[220ms] ease-app',
          sidebarCollapsed && 'w-[46px]',
        )}
      >
        <nav className={cn('flex flex-1 flex-col overflow-y-auto pt-3 pb-2', sidebarCollapsed ? 'gap-2.5 px-[5px]' : 'gap-2 px-2.5')}>
          {sections.map((section) => {
            const state = sectionState(section.id)
            return (
              /* pipe-section：driver.js 引导锚点，纯字符串保留 */
              <div key={section.id} className="pipe-section flex flex-col gap-0.5">
                <div
                  className={cn(
                    'flex items-center gap-[5px] pt-0 pb-0.5 text-[10.5px] font-bold uppercase tracking-[0.06em] text-content-subtle',
                    sidebarCollapsed ? 'justify-center px-0' : 'px-[7px]',
                  )}
                >
                  {state !== 'none' && (
                    <span
                      className={cn(
                        'inline-flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-full',
                        state === 'done' && 'border border-success-soft bg-success-soft text-success',
                      )}
                    >
                      {state === 'done' && (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                      {state === 'active' && <span className={cn('block h-1.5 w-1.5 rounded-full bg-brand', pulseClass)} />}
                      {state === 'pending' && <span className="h-[5px] w-[5px] rounded-full bg-content-subtle opacity-55" />}
                    </span>
                  )}
                  {!sidebarCollapsed && <span>{section.label}</span>}
                  {state === 'active' && !sidebarCollapsed && (
                    <span className="rounded-full bg-elevated px-[5px] py-px text-[9.5px] font-semibold normal-case tracking-[0.03em] text-content-muted">
                      {t('episode.sidebar.inProgress')}
                    </span>
                  )}
                </div>
                {section.items.map((item, itemIdx) => {
                  const Icon = item.icon
                  const active = activeSubStepKey === item.key
                  return (
                    <button
                      key={item.key}
                      type="button"
                      className={cn(
                        'relative grid items-center rounded-control border border-transparent bg-transparent text-left text-[13px] font-semibold transition-all duration-150 ease-app hover:bg-hover-overlay hover:text-content focus-visible:border-[color:var(--hb-action-primary)] focus-visible:shadow-[0_0_0_3px_var(--hb-focus-ring),var(--hb-button-shadow)] focus-visible:outline-none',
                        sidebarCollapsed ? 'min-h-0 grid-cols-[auto] justify-center px-0 py-1.5' : 'min-h-[34px] grid-cols-[auto_minmax(0,1fr)] gap-2.5 px-2 py-[5px]',
                        // 子步骤连接线（原 .pipe-item-sub:not(:last-child)::after；收起态隐藏）
                        !sidebarCollapsed &&
                          itemIdx < section.items.length - 1 &&
                          'after:absolute after:bottom-[-6px] after:left-[15px] after:top-[23px] after:w-px after:bg-outline after:content-[""]',
                        active
                          ? // ChatFire 签名：激活步骤左侧 3px 品牌色圆角指示条（原 ::before）
                            'bg-active-overlay text-content shadow-none before:absolute before:bottom-[9px] before:left-0 before:top-[9px] before:w-[3px] before:rounded-full before:bg-brand before:content-[""]'
                          : state === 'active'
                            ? 'text-content-secondary'
                            : 'text-content-muted',
                      )}
                      title={sidebarCollapsed ? item.label : undefined}
                      onClick={() => goSubStep(item.key)}
                    >
                      <span
                        className={cn(
                          'relative z-[1] flex shrink-0 items-center justify-center rounded-full border transition-all duration-150',
                          sidebarCollapsed ? 'h-[22px] w-[22px]' : 'h-4 w-4',
                          active
                            ? 'border-content bg-content text-surface'
                            : state === 'done'
                              ? 'border-success-soft bg-success-soft text-success'
                              : state === 'active'
                                ? 'border-[color:var(--hb-brand-glow)] bg-brand-soft text-content-subtle'
                                : 'border-outline bg-elevated text-content-subtle',
                        )}
                      >
                        {sidebarCollapsed ? (
                          <>
                            <Icon size={12} />
                            {state === 'active' && (
                              <span
                                className={cn(
                                  'absolute -right-[3px] -top-[3px] h-[7px] w-[7px] rounded-full border-[1.5px] border-surface bg-brand',
                                  pulseClass,
                                )}
                              />
                            )}
                          </>
                        ) : state === 'done' ? (
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        ) : state === 'active' ? (
                          <span className={cn('block h-1.5 w-1.5 rounded-full bg-brand', pulseClass)} />
                        ) : (
                          <Icon size={11} />
                        )}
                      </span>
                      <span className={cn('flex min-w-0 flex-col gap-px', sidebarCollapsed && 'hidden')}>
                        <span className="flex-1 text-[12.5px]">{item.label}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </nav>

        <div
          className={cn(
            'flex shrink-0 flex-col gap-[7px] border-t border-outline bg-surface-soft pt-[9px] pb-2.5',
            sidebarCollapsed ? 'items-center px-1.5' : 'px-2.5',
          )}
        >
          <button
            type="button"
            className="flex w-full items-center justify-center gap-[5px] min-h-[22px] rounded-md border-none bg-transparent text-[11px] font-semibold font-ui text-content-subtle transition-colors duration-[140ms] hover:bg-hover-overlay hover:text-content"
            title={t(sidebarCollapsed ? 'episode.sidebar.expand' : 'episode.sidebar.collapse')}
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            <svg
              className={cn('shrink-0 transition-transform duration-[220ms] ease-app', sidebarCollapsed && 'rotate-180')}
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
            {!sidebarCollapsed && t('episode.sidebar.collapse')}
          </button>

          <div className={cn('flex flex-col gap-[7px] px-0.5 pt-0.5 pb-1', sidebarCollapsed && 'hidden')}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-bold text-content-secondary">
                {currentStageLabel}
              </span>
              <span className="shrink-0 font-code text-[11px] text-content-subtle">
                {currentMainIdx + 1}/{mainProgressSteps.length}
              </span>
            </div>
            <div className="flex gap-1">
              {mainProgressSteps.map((s, i) => {
                const segDone = i < currentMainIdx || mainStageDone(s.id)
                const segCurrent = i === currentMainIdx
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={cn(
                      'relative h-[5px] flex-1 cursor-pointer overflow-hidden rounded-full border-none bg-track p-0 transition-[background,transform] duration-200 ease-app hover:scale-y-[1.6] focus-visible:shadow-[0_0_0_3px_var(--hb-focus-ring)] focus-visible:outline-none',
                      segDone ? 'bg-success' : segCurrent ? 'bg-brand-soft' : '',
                    )}
                    title={s.label}
                    onClick={() => goMainStage(s.id)}
                  >
                    {/* 当前段流动光效（原 .sidebar-progress-seg.current .sidebar-progress-seg-fill） */}
                    {segCurrent && (
                      <span className="absolute inset-0 animate-[seg-marquee_1.5s_linear_infinite] bg-[linear-gradient(90deg,var(--hb-brand)_0%,color-mix(in_srgb,var(--hb-brand)_30%,#fff_70%)_50%,var(--hb-brand)_100%)] bg-[length:220%_100%]" />
                    )}
                  </button>
                )
              })}
            </div>
            <div className="flex gap-1">
              {mainProgressSteps.map((s, i) => (
                <span
                  key={s.id}
                  className={cn(
                    'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-center text-[10.5px]',
                    i === currentMainIdx ? 'font-bold text-brand-content' : i < currentMainIdx || mainStageDone(s.id) ? 'text-success' : 'text-content-subtle',
                  )}
                >
                  {s.label}
                </span>
              ))}
            </div>
          </div>

          <button
            type="button"
            className={cn(
              'flex w-full items-center justify-center gap-1.5 min-h-[28px] rounded-pill border border-transparent bg-button px-2.5 text-[12.5px] font-[650] text-button-content shadow-[var(--hb-button-shadow)] transition-all duration-150 ease-app hover:bg-button-hover hover:text-button-content hover:shadow-[var(--hb-button-shadow-hover)] focus-visible:border-[color:var(--hb-action-primary)] focus-visible:shadow-[0_0_0_3px_var(--hb-focus-ring),var(--hb-button-shadow-hover)] focus-visible:outline-none',
              sidebarCollapsed && 'w-7 min-h-7 gap-0 p-0 text-[0px]',
            )}
            onClick={() => void wb.refresh()}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            {t('episode.sidebar.refreshData')}
          </button>
        </div>
      </aside>
    </>
  )
}

export function useGoSubStep() {
  const setStage = useWorkbenchStore((s) => s.setStage)
  const setScriptStep = useWorkbenchStore((s) => s.setScriptStep)
  const setProdTab = useWorkbenchStore((s) => s.setProdTab)
  return (key: string) => {
    if (key.startsWith('script:')) {
      setStage('script')
      setScriptStep(key === 'script:raw' ? 0 : 1)
      return
    }
    if (key.startsWith('prod:')) {
      setStage('production')
      setProdTab(key.replace('prod:', '') as 'assets' | 'videos')
      return
    }
    setStage('export')
  }
}

export function useGoMainStage() {
  const setStage = useWorkbenchStore((s) => s.setStage)
  const setProdTab = useWorkbenchStore((s) => s.setProdTab)
  return (stageId: string) => {
    if (stageId === 'script') {
      setStage('script')
      setProdTab('assets')
      return
    }
    if (stageId === 'assets') {
      setStage('production')
      setProdTab('assets')
      return
    }
    if (stageId === 'videos') {
      setStage('production')
      setProdTab('videos')
      return
    }
    setStage('export')
  }
}
