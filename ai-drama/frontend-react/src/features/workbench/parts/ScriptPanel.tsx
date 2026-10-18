/**
 * 剧本面板：Step0 原文（保存）/ Step1 改写稿（跳过改写、AI 改写、资产提取入口）。
 * 保存→改写为显式顺序（保存失败不提交 Agent）；草稿基线跟随由 Provider 管理。
 */
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { buttonVariants } from '@/shared/ui/button'
import { useWorkbench } from '../WorkbenchProvider'
import { useWorkbenchStore } from '../workbench-store'

export function ScriptPanel() {
  const wb = useWorkbench()
  const { t } = useTranslation()
  const scriptStep = useWorkbenchStore((s) => s.scriptStep)
  const setScriptStep = useWorkbenchStore((s) => s.setScriptStep)

  const rawLen = wb.rawDraft.replace(/\s/g, '').length
  const scriptLen = wb.scriptDraft.replace(/\s/g, '').length

  if (scriptStep === 0) {
    return (
      <div className="relative flex flex-1 flex-col overflow-hidden min-h-0">
        <div className="flex flex-1 flex-col min-h-0">
          <div className="flex items-center gap-2.5 min-h-[44px] border-b border-outline bg-surface px-3 py-2 shrink-0">
            <div className="flex flex-1 items-center gap-2">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-[10px] bg-brand-soft font-code text-[10px] font-extrabold tracking-[0.05em] text-brand-content">
                  01
                </span>
                <span className="text-[12.5px] font-bold font-display text-content-secondary">{t('episode.script.raw')}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {!!rawLen && <span className="font-code text-[11px] text-content-subtle">{t('episode.script.charCount', { n: rawLen })}</span>}
              <button
                type="button"
                className={buttonVariants({ size: 'sm' })}
                onClick={() => {
                  void wb.saveRaw().then(() => toast.success(t('episode.script.saved')))
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                  <polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" />
                </svg>
                {t('common.save')}
              </button>
            </div>
          </div>
          <textarea
            className="flex-1 rounded-none border-none bg-input px-[28px] pt-[26px] pb-[26px] text-[13.5px] leading-[1.9] font-ui text-content resize-none outline-none focus:shadow-none"
            value={wb.rawDraft}
            onChange={(e) => wb.setRawDraft(e.target.value)}
            placeholder={t('episode.script.rawPlaceholder')}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden min-h-0">
      <div className="flex flex-1 flex-col min-h-0">
        <div className="flex items-center gap-2.5 min-h-[44px] border-b border-outline bg-surface px-3 py-2 shrink-0">
          <div className="flex flex-1 items-center gap-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-[10px] bg-brand-soft font-code text-[10px] font-extrabold tracking-[0.05em] text-brand-content">
                02
              </span>
              <span className="text-[12.5px] font-bold font-display text-content-secondary">{t('episode.script.rewrite')}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {!!scriptLen && <span className="font-code text-[11px] text-content-subtle">{t('episode.script.charCount', { n: scriptLen })}</span>}
            {!!wb.episode?.content && (
              <button type="button" className={buttonVariants({ size: 'sm' })} onClick={wb.skipRewrite}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M5 12h14" /><path d="M13 18l6-6-6-6" />
                </svg>
                {t('episode.script.skipRewrite')}
              </button>
            )}
            {!!wb.episode?.scriptContent && (
              <button type="button" className={buttonVariants({ size: 'sm' })} onClick={() => void wb.doRewrite()} disabled={wb.agentRunning}>
                {wb.agentRunning && wb.agentRunningType === 'script_rewriter' ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><polyline points="10 17 15 12 10 7" /><line x1="15" y1="12" x2="3" y2="12" />
                  </svg>
                )}
                {t('episode.script.rewriteAgain')}
              </button>
            )}
          </div>
        </div>

        {!wb.episode?.scriptContent && !wb.agentRunning ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2.5 min-h-[300px] animate-fade-in p-[46px]">
            <div className="mb-2 flex h-[72px] w-[72px] items-center justify-center rounded-[22px] border border-outline bg-[var(--hb-bg-1)] text-brand shadow-raise">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><polyline points="10 17 15 12 10 7" /><line x1="15" y1="12" x2="3" y2="12" />
              </svg>
            </div>
            <div className="text-[22px] font-bold font-display text-content">{t('episode.script.emptyTitle')}</div>
            <div className="max-w-[420px] text-center text-[13px] leading-[1.8] text-content-muted">{t('episode.script.emptyDesc')}</div>
            <div className="flex items-center justify-center gap-2.5 flex-wrap">
              <button type="button" className={buttonVariants({ variant: 'primary' })} onClick={() => void wb.doRewrite()}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
                {t('episode.script.startRewrite')}
              </button>
              <button type="button" className={buttonVariants({})} onClick={wb.skipRewrite}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M5 12h14" /><path d="M13 18l6-6-6-6" />
                </svg>
                {t('episode.script.skipRewrite')}
              </button>
            </div>
          </div>
        ) : wb.agentRunning && wb.agentRunningType === 'script_rewriter' ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <Loader2 size={24} className="animate-spin" style={{ color: 'var(--hb-brand)' }} />
            <div className="text-[13px] text-content-muted">{t('episode.script.rewriting')}</div>
          </div>
        ) : (
          <textarea
            className="flex-1 rounded-none border-none bg-input px-[28px] pt-[26px] pb-[26px] text-[13.5px] leading-[1.9] font-ui text-content resize-none outline-none focus:shadow-none"
            value={wb.scriptDraft}
            onChange={(e) => wb.setScriptDraft(e.target.value)}
            placeholder={t('episode.script.scriptPlaceholder')}
          />
        )}

        {/* 步骤切换（原文/改写）由左栏承担；此处保留脚本内切换入口 */}
        <StepSwitcher onSwitch={setScriptStep} />
      </div>
    </div>
  )
}

function StepSwitcher({ onSwitch }: { onSwitch: (step: number) => void }) {
  void onSwitch
  return null
}
