/** 工作台顶栏：返回/标题/进度 + 三类模型选择 + 分辨率 + 任务抽屉/刷新/帮助 */
import { useTranslation } from 'react-i18next'
import { CircleHelp, ListTodo } from 'lucide-react'
import { ModelSelect } from '@/shared/ui/ModelSelect'
import { LocaleSwitcher } from '@/shared/ui/LocaleSwitcher'
import { useWorkbench } from '../WorkbenchProvider'
import { useWorkbenchStore } from '../workbench-store'
import { usePreferences } from '@/shared/config/preferences'
import { RESOLUTION_TIERS } from '../workbench-lib'
import { buttonVariants } from '@/shared/ui/button'
import { cn } from '@/shared/lib/cn'

interface TopbarProps {
  dramaTitle: string
  onBack: () => void
  onHelp: () => void
}

// 原 .studio-topbar :global(.btn) 顶栏按钮覆盖（height/padding/字号；min-height 仍由 buttonVariants 保持 36px）
const topbarBtnClass = 'h-[26px] px-[9px] text-[10.5px] whitespace-nowrap'

export function WorkbenchTopbar({ dramaTitle, onBack, onHelp }: TopbarProps) {
  const { t } = useTranslation()
  const wb = useWorkbench()
  const setModelPref = usePreferences((s) => s.setModelPref)
  const chatModel = usePreferences((s) => s.modelPrefs.chat)
  const imageModel = usePreferences((s) => s.modelPrefs.image)
  const videoModel = usePreferences((s) => s.modelPrefs.video)
  const taskDrawerOpen = useWorkbenchStore((s) => s.taskDrawerOpen)
  const setTaskDrawerOpen = useWorkbenchStore((s) => s.setTaskDrawerOpen)

  const resolutionOptions = (RESOLUTION_TIERS[wb.resolutionProvider] ?? RESOLUTION_TIERS.volcengine!).map((key) => ({
    key,
    model: `${resolutionDisplay(wb.resolutionProvider, key)} · ${t(`episode.resolution.${key === '480p' ? 'smooth' : key === '720p' ? 'hd' : 'uhd'}`)}`,
  }))

  return (
    <header className="flex items-center justify-between gap-2 shrink-0 min-h-10 rounded-panel border border-outline bg-header py-1 px-2.5 shadow-card backdrop-blur-[20px] backdrop-saturate-[1.8] max-860:flex-col max-860:items-stretch">
      {/* studio-topbar-main：driver.js 引导锚点，纯字符串保留 */}
      <div className="studio-topbar-main flex items-center gap-2 p-0 min-w-0 max-860:items-start">
        {/* 原 .back-btn + .studio-topbar .topbar-back 覆盖 */}
        <button
          type="button"
          className={cn(
            buttonVariants({}),
            'h-[26px] w-auto min-w-[72px] gap-1.5 border-none px-3 text-[11px] leading-none font-[650] bg-track text-content-secondary transition-all hover:bg-active-overlay hover:text-content',
          )}
          onClick={onBack}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
          </svg>
          {t('episode.topbar.back')}
        </button>
        <div className="flex min-w-0 items-center gap-1.5 flex-wrap">
          <h1 className="text-[13px] leading-none tracking-[-0.04em] whitespace-nowrap">{dramaTitle}</h1>
          <span className="inline-flex h-[18px] items-center rounded-pill bg-brand-soft px-2 text-[9px] font-bold text-brand-content">
            {t('episode.topbar.episodeN', { n: wb.episodeNumber })}
          </span>
          <div className="flex min-w-0 items-center gap-1 flex-nowrap">
            <CurrentStagePill />
            <ProgressPill />
            <span className="text-[9px] font-semibold whitespace-nowrap text-content-subtle">
              {t('episode.topbar.meta', { roles: wb.chars.length, shots: wb.sbs.length })}
            </span>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 max-860:flex-wrap max-860:justify-between">
        <div className="mr-3 flex items-center gap-3 border-r border-outline pr-3">
          {wb.textModelOptions.length > 0 && (
            <ModelSelect
              label={t('common.serviceType.text')}
              value={chatModel}
              onChange={(v) => setModelPref('chat', v)}
              options={wb.textModelOptions}
              defaultLabel={t('episode.model.defaultWith', { model: wb.textModelOptions[0]!.model })}
            />
          )}
          {wb.imageModelOptions.length > 0 && (
            <ModelSelect
              label={t('common.serviceType.image')}
              value={imageModel}
              onChange={(v) => setModelPref('image', v)}
              options={wb.imageModelOptions}
              defaultLabel={t('episode.model.defaultWith', { model: wb.imageModelOptions[0]!.model })}
            />
          )}
          {wb.videoModelOptions.length > 0 && (
            <ModelSelect
              label={t('common.serviceType.video')}
              value={videoModel}
              onChange={(v) => setModelPref('video', v)}
              options={wb.videoModelOptions}
              defaultLabel={t('episode.model.defaultWith', { model: wb.videoModelOptions[0]!.model })}
            />
          )}
          <ModelSelect
            label={t('episode.topbar.resolution')}
            value={wb.episodeResolution}
            onChange={(v) => void wb.changeEpisodeResolution(v)}
            options={resolutionOptions.map((o) => ({ key: o.key, model: o.model, provider: wb.resolutionProvider }))}
            hideDefault
          />
        </div>
        {/* studio-actions：driver.js 引导锚点，纯字符串保留 */}
        <div className="studio-actions flex gap-1.5 max-860:flex-wrap">
          <LocaleSwitcher />
          <button type="button" className={cn(buttonVariants({ size: 'icon' }), 'tour-help-btn', topbarBtnClass)} title={t('tour.helpTitle')} onClick={onHelp}>
            <CircleHelp size={14} strokeWidth={1.8} />
          </button>
          <button type="button" className={cn(buttonVariants({}), topbarBtnClass)} onClick={() => void wb.refresh()}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            {t('common.refresh')}
          </button>
          <button type="button" className={cn(buttonVariants({}), 'relative', topbarBtnClass)} onClick={() => setTaskDrawerOpen(!taskDrawerOpen)}>
            <ListTodo size={12} />
            {t('episode.topbar.tasks')}
            {!!genTaskActiveCount(wb.jobs) && (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold leading-none text-white">
                {genTaskActiveCount(wb.jobs)}
              </span>
            )}
          </button>
        </div>
      </div>
    </header>
  )
}

function CurrentStagePill() {
  const { t } = useTranslation()
  const wb = useWorkbench()
  const stage = useWorkbenchStore((s) => s.stage)
  const scriptStep = useWorkbenchStore((s) => s.scriptStep)
  const prodTab = useWorkbenchStore((s) => s.prodTab)
  const exportDone = wb.episode?.status === 'completed'
  const label =
    stage === 'script'
      ? t('episode.stage.scriptStage', { step: scriptStep === 0 ? t('episode.script.raw') : t('episode.script.rewrite') })
      : stage === 'production'
        ? t('episode.stage.prodStage', { step: prodTab === 'assets' ? t('episode.prod.assets') : t('episode.prod.videos') })
        : exportDone
          ? t('episode.stage.exportDone')
          : t('episode.stage.exportWaiting')
  return (
    <span className="inline-flex h-[18px] items-center rounded-pill bg-brand-soft px-2 text-[8px] font-semibold whitespace-nowrap text-brand-content">
      {label}
    </span>
  )
}

function ProgressPill() {
  const wb = useWorkbench()
  const stage = useWorkbenchStore((s) => s.stage)
  const prodTab = useWorkbenchStore((s) => s.prodTab)
  const scriptDone = !!wb.episode?.scriptContent
  const assetTotal = wb.visualChars.length + wb.scenes.length + wb.props.length
  const assetReady =
    wb.visualChars.filter((c) => c.imageUrl).length + wb.scenes.filter((s) => s.imageUrl).length + wb.props.filter((p) => p.imageUrl).length
  const assetsDone = assetTotal > 0 && assetReady === assetTotal
  const videosDone = wb.sbs.length > 0 && wb.sbs.every((s) => !!(s.videoUrl || s.composedVideoUrl))
  const doneCount = [scriptDone, assetsDone, videosDone].filter(Boolean).length
  void stage
  void prodTab
  return (
    <span className="inline-flex h-[18px] items-center rounded-pill bg-success-soft px-2 text-[8px] font-semibold whitespace-nowrap text-success">
      {doneCount}/2
    </span>
  )
}

function resolutionDisplay(provider: string, key: string): string {
  const display: Record<string, Record<string, string>> = {
    volcengine: { '480p': '480p', '720p': '720p', '1080p': '720p' },
    minimax: { '480p': '768P', '720p': '768P', '1080p': '2K' },
    aliyun: { '480p': '480P', '720p': '720P', '1080p': '1080P' },
  }
  return display[provider]?.[key] || key
}

function genTaskActiveCount(jobs: { tasks: { status: string }[]; merges: { status: string }[] }): number {
  return (
    jobs.tasks.filter((x) => x.status === 'processing').length +
    jobs.merges.filter((m) => m.status === 'processing' || m.status === 'pending').length
  )
}
