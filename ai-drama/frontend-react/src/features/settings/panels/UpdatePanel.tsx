/** 关于更新面板：桌面版走 Electron 桥；服务器/Docker 走后端 server-update 路由 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Check, Download, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { serverUpdateApi, type ServerUpdateState } from '@/entities/settings/api'
import { toastError } from '@/shared/lib/errors'
import { getDesktopBridge, type UpdateState } from '@/shared/desktop/bridge'
import { Button } from '@/shared/ui/button'
import { cardVariants } from '@/shared/ui/card'
import { cn } from '@/shared/lib/cn'

// settings-scroll 直接子元素限宽居中
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
const CONFIG_EMPTY = 'px-5 py-3.5 text-[12px] text-content-subtle'
const CONFIG_EMPTY_STANDALONE = `${CONFIG_EMPTY} ${CONTENT_W}`
const UPDATE_BAR = 'mt-1.5 h-[5px] w-[220px] overflow-hidden rounded-[3px] bg-track'
const UPDATE_BAR_FILL = 'h-full rounded-[3px] bg-brand transition-[width] duration-200 ease-[ease]'

export function UpdatePanel() {
  const { t } = useTranslation()
  const desktopBridge = getDesktopBridge()

  const [updateState, setUpdateState] = useState<UpdateState | ServerUpdateState | null>(null)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateDownloading, setUpdateDownloading] = useState(false)
  const [updateProgress, setUpdateProgress] = useState(0)
  const [updateApplying, setUpdateApplying] = useState(false)
  const [serverUpdateMode, setServerUpdateMode] = useState<'watchtower' | 'manual'>('manual')

  function refreshUpdateState() {
    void (async () => {
      try {
        if (desktopBridge) {
          setUpdateState(await desktopBridge.getUpdateState())
        } else {
          const s = await serverUpdateApi.state()
          setServerUpdateMode(s.updateMode || 'manual')
          setUpdateState(s)
        }
      } catch {
        /* 静默 */
      }
    })()
  }

  useEffect(() => {
    refreshUpdateState()
     
  }, [])

  async function checkUpdate() {
    setUpdateChecking(true)
    try {
      if (desktopBridge) {
        setUpdateState(await desktopBridge.checkUpdate())
      } else {
        const s = await serverUpdateApi.check()
        setServerUpdateMode(s.updateMode || 'manual')
        setUpdateState(s)
      }
      // 泛型读取最新值：闭包里的 updateState 不可靠
    } catch (err) {
      toastError(err, { fallback: 'settings.about.checkFailedToast' })
      refreshUpdateState()
    } finally {
      setUpdateChecking(false)
    }
  }

  async function downloadUpdate() {
    if (!desktopBridge) return
    setUpdateDownloading(true)
    setUpdateProgress(0)
    const unProgress = desktopBridge.onUpdateProgress((p) => setUpdateProgress(p))
    try {
      setUpdateState(await desktopBridge.downloadUpdate())
      toast.success(t('settings.about.downloadDone'))
    } catch (err) {
      toastError(err, { fallback: 'settings.about.downloadFailed' })
      refreshUpdateState()
    } finally {
      unProgress()
      setUpdateDownloading(false)
    }
  }

  async function applyUpdate() {
    setUpdateApplying(true)
    try {
      if (desktopBridge) {
        await desktopBridge.applyUpdate()
        // 成功路径：应用退出并由更新后的版本接管，不会走到这里
      } else {
        await serverUpdateApi.apply()
        // Watchtower 异步拉镜像重建容器，本进程随后被替换
        toast.success(t('settings.about.serverApplyStarted'), { duration: 8000 })
        setUpdateApplying(false)
      }
    } catch (err) {
      setUpdateApplying(false)
      toastError(err, { fallback: desktopBridge ? 'settings.about.installFailed' : 'settings.about.serverApplyFailed' })
      refreshUpdateState() // 桌面端 apply 失败会把具体原因写进 updateState.error
    }
  }

  const status = updateState?.status
  const isDownloadingRow = status === 'available' || status === 'downloading'

  return (
    <div className={PANEL_SCROLL}>
      <div className={SETTINGS_HEAD}>
        <h2 className={SETTINGS_TITLE}>{t('settings.about.title')}</h2>
        <p className={SETTINGS_DESC}>{t('settings.about.desc')}</p>
      </div>
      <section className={cn(cardVariants(), CONTENT_W, SVC_GROUP)}>
        <div className={SVC_GROUP_HEAD}>
          <div className={SVC_GROUP_HEADING}>
            <span className={SVC_GROUP_TITLE}>
              {t('settings.about.currentVersion', { v: updateState?.currentVersion || '…' })}
            </span>
            {updateState?.latestVersion && (
              <div className={SVC_GROUP_SUB}>{t('settings.about.latestVersion', { v: updateState.latestVersion })}</div>
            )}
          </div>
          <Button variant="primary" size="sm" className="ml-auto" disabled={updateChecking} onClick={() => void checkUpdate()}>
            {updateChecking ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {t('settings.about.check')}
          </Button>
        </div>

        {status === 'up-to-date' && (
          <div className={CONFIG_ROW}>
            <div className={PROVIDER_BADGE}><Check size={15} /></div>
            <div className={CONFIG_MAIN}>
              <div className={CONFIG_LINE}><span className={CONFIG_NAME}>{t('settings.about.upToDate')}</span></div>
            </div>
          </div>
        )}
        {isDownloadingRow && (
          <div className={CONFIG_ROW}>
            <div className={PROVIDER_BADGE}><Sparkles size={15} /></div>
            <div className={CONFIG_MAIN}>
              <div className={CONFIG_LINE}>
                <span className={CONFIG_NAME}>{t('settings.about.found', { v: updateState?.latestVersion })}</span>
              </div>
              {updateState?.notes && <div className={CONFIG_SUB}>{updateState.notes}</div>}
              {(status === 'downloading' || updateDownloading) && (
                <div className={UPDATE_BAR}>
                  <div className={UPDATE_BAR_FILL} style={{ width: `${updateProgress}%` }} />
                </div>
              )}
              {/* 服务器手动模式：无 Watchtower，给出更新命令 */}
              {!desktopBridge && serverUpdateMode === 'manual' && (
                <div className={CONFIG_SUB}>
                  {t('settings.about.serverManualHint')} <span className="font-code">docker compose up -d --build</span>
                </div>
              )}
            </div>
            {/* 桌面版：下载更新包 */}
            {desktopBridge ? (
              <Button variant="primary" size="sm" disabled={updateDownloading} onClick={() => void downloadUpdate()}>
                {updateDownloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                {updateDownloading ? t('settings.about.downloading', { p: updateProgress }) : t('settings.about.download')}
              </Button>
            ) : serverUpdateMode === 'watchtower' ? (
              /* 服务器 + Watchtower：一键触发拉镜像重建 */
              <Button variant="primary" size="sm" disabled={updateApplying} onClick={() => void applyUpdate()}>
                {updateApplying ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                {t('settings.about.serverApply')}
              </Button>
            ) : null}
          </div>
        )}
        {status === 'downloaded' && (
          <div className={CONFIG_ROW}>
            <div className={PROVIDER_BADGE}><Download size={15} /></div>
            <div className={CONFIG_MAIN}>
              <div className={CONFIG_LINE}><span className={CONFIG_NAME}>{t('settings.about.ready')}</span></div>
              <div className={CONFIG_SUB}>{t('settings.about.readyDesc')}</div>
            </div>
            <Button variant="primary" size="sm" disabled={updateApplying} onClick={() => void applyUpdate()}>
              {updateApplying && <Loader2 size={13} className="animate-spin" />}
              {t('settings.about.restartInstall')}
            </Button>
          </div>
        )}
        {status === 'error' && (
          <div className={CONFIG_ROW}>
            <div className={PROVIDER_BADGE}><RefreshCw size={15} /></div>
            <div className={CONFIG_MAIN}>
              <div className={CONFIG_LINE}><span className={CONFIG_NAME}>{t('settings.about.checkFailed')}</span></div>
              <div className={CONFIG_SUB}>{updateState?.error}</div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => void checkUpdate()}>
              {t('settings.about.retry')}
            </Button>
          </div>
        )}
        {!status && <p className={CONFIG_EMPTY}>{t('settings.about.empty')}</p>}
      </section>
      {desktopBridge ? (
        <p className={CONFIG_EMPTY_STANDALONE}>{t('settings.about.note')}</p>
      ) : (
        <p className={CONFIG_EMPTY_STANDALONE}>{t('settings.about.serverNote')}</p>
      )}
    </div>
  )
}
