/** 存储位置面板：用量统计（stale 时 2s 轮询至新鲜）、桌面模式迁移向导 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Database, HardDrive } from 'lucide-react'
import { qk } from '@/shared/api/query-keys'
import { storageApi, type StorageInfo } from '@/entities/settings/api'
import { toastError } from '@/shared/lib/errors'
import { formatBytes } from '@/features/desktop-operations/migrate-store'
import { migrateOperations } from '@/features/desktop-operations/migrate-store'
import { getDesktopBridge } from '@/shared/desktop/bridge'
import { resetWorkspaceCache } from '@/shared/api/query-keys'
import { Button } from '@/shared/ui/button'
import { Badge } from '@/shared/ui/badge'
import { cardVariants } from '@/shared/ui/card'
import { Modal } from '@/shared/ui/Modal'
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
const STORAGE_BREAKDOWN = 'mt-0.5 flex flex-wrap gap-1.5'
const CONFIG_EMPTY = 'px-5 py-3.5 text-[12px] text-content-subtle'

export function StoragePanel() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const desktopBridge = getDesktopBridge()

  // 面板挂载即查询；usageStale 时 2s 轮询直到新鲜（离开面板即卸载停止）
  const storageQuery = useQuery({
    queryKey: qk.storage(),
    queryFn: ({ signal }) => storageApi.info(signal),
    staleTime: 5_000,
    refetchInterval: (query) => {
      const data = query.state.data as StorageInfo | undefined
      return data && (data.usageStale || !data.usage) ? 2000 : false
    },
    retry: false,
  })
  const storageInfo = storageQuery.data

  const [migrateDialog, setMigrateDialog] = useState(false)
  const [migrateTarget, setMigrateTarget] = useState('')
  const [migrateTargetFree, setMigrateTargetFree] = useState<number | null>(null)
  const [migrateFiles, setMigrateFiles] = useState(true)
  const [migrating, setMigrating] = useState(false)
  const migratingRef = useRef(false)

  const isDesktopMode = storageInfo?.mode === 'desktop' && !!desktopBridge

  // 迁移发起后全局遮罩展示进度；本组件可能随整页刷新销毁
  useEffect(() => {
    migratingRef.current = migrating
  }, [migrating])

  async function pickTarget() {
    if (!desktopBridge) return
    const res = await desktopBridge.pickDirectory()
    if (res.canceled) return
    if (!res.ok || !res.path) {
      toastError(res.error, { fallback: 'settings.migrate.pickFailed' })
      return
    }
    setMigrateTarget(res.path)
    setMigrateTargetFree(res.freeBytes ?? null)
    setMigrateFiles(true)
    setMigrateDialog(true)
  }

  async function startMigrate() {
    if (!desktopBridge || !migrateTarget) return
    setMigrating(true)
    migratingRef.current = true
    migrateOperations.begin()
    try {
      await desktopBridge.startMigration({ targetDir: migrateTarget, migrateFiles })
      // 成功的完成提示与页面刷新由全局进度订阅（DesktopBootstrap）处理
      // 迁移成功切换数据源：清空旧缓存防止旧目录数据污染（页面随 done 事件 reload）
      resetWorkspaceCache(queryClient)
    } catch (err) {
      migrateOperations.end()
      toastError(err, { fallback: 'settings.migrate.failed' })
    } finally {
      setMigrating(false)
      migratingRef.current = false
      setMigrateDialog(false)
    }
  }

  return (
    <div className={PANEL_SCROLL}>
      <div className={SETTINGS_HEAD}>
        <h2 className={SETTINGS_TITLE}>{t('settings.storage.title')}</h2>
        <p className={SETTINGS_DESC}>{t('settings.storage.desc')}</p>
      </div>
      <section className={cn(cardVariants(), CONTENT_W, SVC_GROUP)}>
        <div className={SVC_GROUP_HEAD}>
          <div className={SVC_GROUP_HEADING}>
            <span className={SVC_GROUP_TITLE}>{t('settings.storage.currentDir')}</span>
            {storageInfo?.computedAt && (
              <div className={SVC_GROUP_SUB}>
                {t('settings.storage.computedAt', { time: new Date(storageInfo.computedAt).toLocaleString() })}
              </div>
            )}
          </div>
          {isDesktopMode && (
            <Button variant="primary" size="sm" className="ml-auto" disabled={migrating} onClick={() => void pickTarget()}>
              <HardDrive size={13} /> {t('settings.storage.changeLocation')}
            </Button>
          )}
        </div>
        <div className={CONFIG_ROW}>
          <div className={PROVIDER_BADGE}>
            <HardDrive size={15} />
          </div>
          <div className={CONFIG_MAIN}>
            <div className={CONFIG_LINE}>
              <span className={CONFIG_NAME}>{t('settings.storage.dataDir')}</span>
              <Badge mono>
                {storageInfo?.mode === 'desktop' ? t('settings.storage.desktopMode') : t('settings.storage.serverMode')}
              </Badge>
            </div>
            <div className={`font-code truncate ${CONFIG_SUB}`}>{storageInfo?.dataDir || t('common.loading')}</div>
            <div className={`font-code truncate ${CONFIG_SUB}`}>{storageInfo?.sqlitePath || ''}</div>
          </div>
        </div>
        {storageInfo?.usage && (
          <div className={`${CONFIG_ROW} border-t border-outline`}>
            <div className={PROVIDER_BADGE}>
              <Database size={15} />
            </div>
            <div className={CONFIG_MAIN}>
              <div className={CONFIG_LINE}>
                <span className={CONFIG_NAME}>
                  {t('settings.storage.totalUsage', { size: formatBytes(storageInfo.usage.total) })}
                </span>
                {storageInfo.usageStale && <Badge>{t('settings.storage.counting')}</Badge>}
              </div>
              <div className={STORAGE_BREAKDOWN}>
                <Badge mono>{t('settings.storage.breakdown.db')} {formatBytes(storageInfo.usage.db)}</Badge>
                <Badge mono>{t('settings.storage.breakdown.images')} {formatBytes(storageInfo.usage.images)}</Badge>
                <Badge mono>{t('settings.storage.breakdown.videos')} {formatBytes(storageInfo.usage.videos)}</Badge>
                <Badge mono>{t('settings.storage.breakdown.merged')} {formatBytes(storageInfo.usage.merged)}</Badge>
                <Badge mono>{t('settings.storage.breakdown.uploads')} {formatBytes(storageInfo.usage.uploads)}</Badge>
                {!!storageInfo.usage.temp && <Badge mono>{t('settings.storage.breakdown.temp')} {formatBytes(storageInfo.usage.temp)}</Badge>}
                {!!storageInfo.usage.other && <Badge mono>{t('settings.storage.breakdown.other')} {formatBytes(storageInfo.usage.other)}</Badge>}
              </div>
              {storageInfo.freeBytes != null && (
                <div className={CONFIG_SUB}>{t('settings.storage.diskFree', { size: formatBytes(storageInfo.freeBytes) })}</div>
              )}
            </div>
          </div>
        )}
        <p className={CONFIG_EMPTY}>{t('settings.storage.note')}</p>
        {!isDesktopMode && <p className={CONFIG_EMPTY}>{t('settings.storage.serverNote')}</p>}
      </section>

      {/* 迁移确认（自建 dialog：删除语义的 ConfirmDialog 不合此处） */}
      <Modal
        open={migrateDialog}
        onOpenChange={(v) => {
          if (!v && !migrating) setMigrateDialog(false)
        }}
        width={480}
        title={t('settings.migrate.title')}
        footer={
          <>
            <Button disabled={migrating} onClick={() => setMigrateDialog(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" disabled={migrating} onClick={() => void startMigrate()}>
              {migrating && <span className="animate-spin" style={{ display: 'inline-flex' }} />}
              {t('settings.migrate.start')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-[550] text-content-secondary">{t('settings.migrate.newDir')}</span>
          <div
            className="w-full rounded-control border border-outline-strong bg-input px-3.5 py-[9px] text-content text-form tracking-[-0.01em] font-code"
            style={{ wordBreak: 'break-all' }}
          >
            {migrateTarget}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-[550] text-content-secondary">{t('settings.migrate.dataToMove')}</span>
          <div className="text-micro leading-[1.5] text-content-subtle">
            {t('settings.migrate.sizeNote', { size: formatBytes(storageInfo?.usage?.total ?? 0) })}
            {migrateTargetFree != null && t('settings.migrate.freeNote', { size: formatBytes(migrateTargetFree) })}
          </div>
        </div>
        <label className="flex flex-col gap-1.5" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={migrateFiles} disabled={migrating} onChange={(e) => setMigrateFiles(e.target.checked)} />
          <span className="text-xs font-[550] text-content-secondary" style={{ margin: 0 }}>{t('settings.migrate.moveFiles')}</span>
        </label>
        {!migrateFiles && <p className="text-micro leading-[1.5] text-danger">{t('settings.migrate.emptyWarn')}</p>}
        <p className="text-micro leading-[1.5] text-content-subtle">{t('settings.migrate.note')}</p>
      </Modal>
    </div>
  )
}
