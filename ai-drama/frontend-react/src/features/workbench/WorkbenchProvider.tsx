/**
 * 工作台数据查询、状态与动作编排。
 *
 * 关键架构决定（对照重构文档）：
 * - 服务端数据全部由 React Query 持有：项目详情（定位 episodeId）、单集资产/分镜、
 *   聚合任务 jobs（唯一轮询同步入口，替代旧版散布的手动定时器）、成片列表、AI 配置
 * - 视频 pending/失败状态从 jobs 派生（每个分镜取最新一条任务重建），页面刷新后自动恢复；
 *   终态 toast 由「上一快照 → 新快照」转移检测去重，首次加载历史记录不提示
 * - 保存→改写显式 await 顺序（修正旧版不等待保存结果即提交 Agent 的问题）
 * - 草稿基线跟随：后台刷新不覆盖 dirty 草稿（修正旧版 watch 无条件重置）
 * - UI 交互状态走按剧集作用域的 zustand store；面板记忆/模型选择走全局 preferences
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { dramaQueries } from '@/entities/drama/queries'
import type { Drama } from '@/entities/drama/model'
import { episodeQueries } from '@/entities/episode/queries'
import { episodeApi } from '@/entities/episode/api'
import { aiConfigQueries } from '@/entities/ai-config/queries'
import type { AiConfig } from '@/entities/ai-config/model'
import { agentChat } from '@/entities/ai-config/workspace-api'
import { mergeApi, taskApi } from '@/entities/generation-task/api'
import type { VideoMerge, SysTask } from '@/entities/generation-task/model'
import { storyboardApi } from '@/entities/storyboard/api'
import { assetApiOf, batchCharacterImages } from '@/entities/asset/api'
import type { Character, Prop, Scene, AssetKind } from '@/entities/asset/model'
import type { Storyboard } from '@/entities/storyboard/model'
import type { Episode } from '@/entities/episode/model'
import { uploadApi } from '@/shared/api/upload'
import { qk } from '@/shared/api/query-keys'
import { toastError, MODERATION_RE } from '@/shared/lib/errors'
import { usePreferences, type PanelMemory } from '@/shared/config/preferences'
import { t as globalT } from '@/shared/config/i18n'
import { useAgent } from './use-agent'
import { createWorkbenchStore, WorkbenchStoreProvider } from './workbench-store'
import {
  bareModelName,
  breakdownMessage,
  collectModelOptions,
  configModels,
  getShotReferenceImages,
  hasVid,
  hasMultiConfigs,
  isNarratorCharacter,
  ownerConfigId,
  pruneStaleModel,
  resolutionProviderOf,
  resolutionShort,
  resolveVideoPromptRefs,
  storyboardScene,
  videoPromptMessage,
  type ModelOption,
  type VideoTaskState,
  clampVideoCol,
} from './workbench-lib'

const EXTRACT_KEYS = ['characters', 'scenes', 'props'] as const
type ExtractKey = (typeof EXTRACT_KEYS)[number]

export interface WorkbenchContextValue {
  dramaId: number
  episodeNumber: number
  dramaError: Error | null
  drama: Drama | undefined
  episode: Episode | null
  episodeId: number
  chars: Character[]
  scenes: Scene[]
  props: Prop[]
  sbs: Storyboard[]
  visualChars: Character[]
  exportMerges: VideoMerge[]
  jobs: { tasks: SysTask[]; merges: VideoMerge[] }
  ready: boolean
  agentRunning: boolean
  agentRunningType: string | null
  textModelOptions: ModelOption[]
  imageModelOptions: ModelOption[]
  videoModelOptions: ModelOption[]
  textModelMultiCfg: boolean
  imageModelMultiCfg: boolean
  videoModelMultiCfg: boolean
  selectedVideoConfig: AiConfig | null
  effectiveVideoModelLabel: string
  resolutionProvider: string
  episodeResolution: string
  dramaAspectRatio: string
  refImageLimit: number
  videoCols: { left: number; right: number }
  setVideoCols: (cols: { left: number; right: number }) => void
  batchPrompt: { running: boolean; total: number; completed: number }
  extractingTargets: string[]
  extractingLabel: string
  pendingCharImageIds: number[]
  pendingSceneImageIds: number[]
  pendingPropImageIds: number[]
  /** 派生的视频 pending（本地乐观 ∪ 服务端 processing） */
  pendingVideoIds: number[]
  /** 派生的视频失败信息（分镜 id → 消息） */
  videoFailMessages: Record<number, string>
  videoStateOf: (sb: Storyboard | null | undefined) => VideoTaskState
  videoModerationHint: (msg: string) => string
  videoPromptGeneratingIds: number[]
  uploadKeys: string[]
  generatingPromptKeys: string[]
  totalDuration: number
  rawDraft: string
  setRawDraft: (v: string) => void
  scriptDraft: string
  setScriptDraft: (v: string) => void
  refresh: () => Promise<void>
  saveRaw: () => Promise<void>
  doRewrite: () => Promise<void>
  skipRewrite: () => void
  doExtract: (target: string) => void
  doExtractAll: () => void
  isExtracting: (target: string) => boolean
  batchVideoPrompts: () => Promise<void>
  doBreakdown: () => void
  genVideoPrompt: (sb: Storyboard) => Promise<void>
  genAssetImage: (kind: AssetKind, id: number) => Promise<void>
  batchAssetImages: (kind: AssetKind) => void
  uploadAssetImage: (kind: AssetKind, id: number) => void
  isUploadingAsset: (kind: AssetKind, id: number) => boolean
  ensureAssetPrompt: (kind: AssetKind, id: number, force?: boolean) => Promise<string>
  isGeneratingPrompt: (kind: AssetKind, id: number) => boolean
  updateField: (sb: Storyboard, field: string, value: unknown) => void
  toggleStoryboardCharacter: (sb: Storyboard, charId: number) => void
  toggleStoryboardProp: (sb: Storyboard, propId: number) => void
  toggleSceneBind: (sb: Storyboard, sceneId: number) => void
  changeEpisodeResolution: (val: string) => Promise<void>
  genVid: (sb: Storyboard, opts?: { silent?: boolean }) => Promise<void>
  batchConfirmTargets: Storyboard[] | null
  openBatchVideoConfirm: (pool: Storyboard[]) => void
  retryFailedVideos: () => void
  confirmBatchVideos: () => void
  closeBatchConfirm: () => void
  doMerge: (ids?: number[]) => Promise<void>
  refreshExportMerges: () => void
  toggleExportDone: () => Promise<void>
  onVideoDurationChange: (sb: Storyboard, raw: string) => void
  chatModelOverride: () => string | undefined
  chatConfigId: () => number | undefined
  imageModelParams: () => { model?: string; configId?: number }
  videoModelParams: () => { model?: string; configId?: number }
  getSceneName: (sb: Storyboard) => string
  shotReferenceImages: (sb: Storyboard) => string[]
  shotReferenceIndexMap: (sb: Storyboard) => Record<string, number>
  videoPromptRefs: (sb: Storyboard) => string
  saveAssetCreate: (type: AssetKind, draft: Record<string, string>) => Promise<void>
  deleteAsset: (type: AssetKind, id: number) => Promise<void>
}

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null)

export function useWorkbench(): WorkbenchContextValue {
  const ctx = useContext(WorkbenchContext)
  if (!ctx) throw new Error('useWorkbench must be used within WorkbenchProvider')
  return ctx
}

const isPageReload = (() => {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    return nav?.type === 'reload'
  } catch {
    return false
  }
})()

export function WorkbenchProvider({
  dramaId,
  episodeNumber,
  children,
}: {
  dramaId: number
  episodeNumber: number
  children: ReactNode
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const prefs = usePreferences()

  // ===== 面板记忆（仅整页 reload 恢复；从列表进入默认剧本） =====
  const panelKey = `${dramaId}:${episodeNumber}`
  const storedPanelRef = useRef<PanelMemory | null>(isPageReload ? (usePreferences.getState().panels[panelKey] ?? null) : null)
  const storedPanel = storedPanelRef.current
  const [store] = useState(() =>
    createWorkbenchStore({
      stage: ['production', 'export'].includes(storedPanel?.panel ?? '') ? (storedPanel!.panel as 'production' | 'export') : 'script',
      scriptStep: storedPanel ? (storedPanel.scriptStep === 0 ? 0 : 1) : 0,
      prodTab: storedPanel?.prodTab === 'videos' || storedPanel?.prodTab === 'assets' ? storedPanel.prodTab : ('assets' as const),
    }),
  )
  const panelRestoredRef = useRef(!!storedPanel)

  // 面板位置变化即持久化
  useEffect(() => {
    return store.subscribe((s) => {
      prefs.setPanelMemory(panelKey, { panel: s.stage, scriptStep: s.scriptStep, prodTab: s.prodTab })
    })
     
  }, [store, panelKey])

  // store 交互状态的轻量镜像（Provider 位于 StoreProvider 外，经订阅同步）
  const [uiMirror, setUiMirror] = useState(() => store.getState())
  useEffect(() => store.subscribe(setUiMirror), [store])

  // ===== 数据查询 =====
  const dramaQuery = useQuery({ ...dramaQueries.detail(dramaId), retry: false })
  const episode = useMemo(
    () => dramaQuery.data?.episodes.find((e) => e.episodeNumber === episodeNumber) ?? null,
    [dramaQuery.data, episodeNumber],
  )
  const episodeId = episode?.id ?? 0

  const charsQuery = useQuery(episodeQueries.characters(episodeId))
  const scenesQuery = useQuery(episodeQueries.scenes(episodeId))
  const propsQuery = useQuery(episodeQueries.props(episodeId))
  const sbsQuery = useQuery(episodeQueries.storyboards(episodeId))
  const mergesQuery = useQuery(episodeQueries.merges(episodeId))

  const chars = charsQuery.data ?? []
  const scenes = scenesQuery.data ?? []
  const props = propsQuery.data ?? []
  const sbs = sbsQuery.data ?? []
  const exportMerges = mergesQuery.data ?? []

  // ===== 生成中跟踪（本地，先于查询声明使用） =====
  const [extractingTargets, setExtractingTargets] = useState<string[]>([])
  const [extractWatch, setExtractWatch] = useState(false)
  const extractStartedAtRef = useRef<Map<string, number>>(new Map())
  const [batchPromptState, setBatchPromptState] = useState({ running: false, total: 0, completed: 0 })
  const [promptWatch, setPromptWatch] = useState(false)
  const [batchConfirmTargets, setBatchConfirmTargets] = useState<Storyboard[] | null>(null)

  // 聚合任务（sys_task + merges）：有进行中任务时 4s 轮询，终态停止
  const jobsQuery = useQuery({
    ...episodeQueries.jobs(episodeId, { routeActive: episodeId > 0, localBackend: true }),
    refetchInterval: (query) => {
      const data = query.state.data
      if (!data) return false
      const active =
        data.tasks.some((j) => j.status === 'processing') ||
        data.merges.some((m) => m.status === 'processing' || m.status === 'pending')
      return active ? 4000 : false
    },
  })
  const jobs = jobsQuery.data ?? { tasks: [], merges: [] }

  const extractStatusQuery = useQuery({
    ...episodeQueries.extractStatus(episodeId),
    enabled: episodeId > 0 && (extractingTargets.length > 0 || extractWatch),
    refetchInterval: extractingTargets.length > 0 ? 2500 : false,
  })
  const promptsStatusQuery = useQuery({
    ...episodeQueries.videoPromptsStatus(episodeId),
    enabled: episodeId > 0 && (batchPromptState.running || promptWatch),
    refetchInterval: batchPromptState.running ? 2500 : false,
  })

  const textCfgQuery = useQuery(aiConfigQueries.list('text'))
  const imageCfgQuery = useQuery(aiConfigQueries.list('image'))
  const videoCfgQuery = useQuery(aiConfigQueries.list('video'))
  const textConfigs = textCfgQuery.data ?? []
  const imageConfigs = imageCfgQuery.data ?? []
  const videoConfigs = videoCfgQuery.data ?? []

  const { running: agentRunning, runningType: agentRunningType, run: runAgent } = useAgent()

  // ===== 模型选择（全局偏好）+ 失效修剪 =====
  const chatModelPref = prefs.modelPrefs.chat
  const imageModelPref = prefs.modelPrefs.image
  const videoModelPref = prefs.modelPrefs.video

  const textModelOptions = useMemo(() => collectModelOptions(textConfigs), [textConfigs])
  const imageModelOptions = useMemo(() => collectModelOptions(imageConfigs), [imageConfigs])
  const videoModelOptions = useMemo(() => collectModelOptions(videoConfigs), [videoConfigs])

  useEffect(() => {
    if (chatModelPref && textModelOptions.length) {
      const pruned = pruneStaleModel(chatModelPref, textModelOptions)
      if (pruned !== chatModelPref) prefs.setModelPref('chat', pruned)
    }
     
  }, [textModelOptions])
  useEffect(() => {
    if (imageModelPref && imageModelOptions.length) {
      const pruned = pruneStaleModel(imageModelPref, imageModelOptions)
      if (pruned !== imageModelPref) prefs.setModelPref('image', pruned)
    }
     
  }, [imageModelOptions])
  useEffect(() => {
    if (videoModelPref && videoModelOptions.length) {
      const pruned = pruneStaleModel(videoModelPref, videoModelOptions)
      if (pruned !== videoModelPref) prefs.setModelPref('video', pruned)
    }
     
  }, [videoModelOptions])

  const chatModelOverride = useCallback(() => bareModelName(chatModelPref) || undefined, [chatModelPref])
  const chatConfigId = useCallback(() => ownerConfigId(textModelOptions, chatModelPref), [textModelOptions, chatModelPref])
  const imageModelParams = useCallback(
    () => ({ model: bareModelName(imageModelPref) || undefined, configId: ownerConfigId(imageModelOptions, imageModelPref) }),
    [imageModelOptions, imageModelPref],
  )
  const videoModelParams = useCallback(
    () => ({ model: bareModelName(videoModelPref) || undefined, configId: ownerConfigId(videoModelOptions, videoModelPref) }),
    [videoModelOptions, videoModelPref],
  )

  const lockedVideoConfigId = episode?.videoConfigId ?? null
  const selectedVideoConfig = useMemo<AiConfig | null>(() => {
    const selected = videoModelOptions.find((o) => o.key === videoModelPref)
    if (selected) return videoConfigs.find((c) => c.id === selected.configId) ?? null
    const locked = videoConfigs.find((c) => c.id === lockedVideoConfigId && c.isActive)
    if (locked) return locked
    return [...videoConfigs].filter((c) => c.isActive).sort((a, b) => (b.priority || 0) - (a.priority || 0))[0] ?? null
  }, [videoModelOptions, videoModelPref, videoConfigs, lockedVideoConfigId])

  const isWan3Video = selectedVideoConfig?.provider === 'aliyun' || bareModelName(videoModelPref).startsWith('wan3.0-video')
  const refImageLimit = isWan3Video ? 10 : 9

  const resolutionProvider = resolutionProviderOf(selectedVideoConfig?.provider)
  const resolutionKeys = useMemo(() => {
    const keys = resolutionProvider === 'volcengine' ? ['480p', '720p'] : resolutionProvider === 'minimax' ? ['720p', '1080p'] : ['480p', '720p', '1080p']
    return keys as string[]
  }, [resolutionProvider])
  const episodeResolution = useMemo(() => {
    const v = episode?.resolution ?? '720p'
    return resolutionKeys.includes(v) ? v : '720p'
  }, [episode?.resolution, resolutionKeys])

  const effectiveVideoModelLabel = bareModelName(videoModelPref) || configModels(selectedVideoConfig)[0] || ''
  const dramaAspectRatio = dramaQuery.data?.aspectRatio || '16:9'

  const visualChars = useMemo(() => chars.filter((c) => !isNarratorCharacter(c)), [chars])
  const totalDuration = useMemo(() => sbs.reduce((sum, sb) => sum + (sb.duration || 10), 0), [sbs])

  // ===== 草稿（基线跟随：后台刷新不覆盖 dirty 草稿） =====
  const remoteRaw = episode?.content ?? ''
  const remoteScript = episode?.scriptContent ?? ''
  const [rawDraft, setRawDraft] = useState(remoteRaw)
  const [scriptDraft, setScriptDraft] = useState(remoteScript)
  const lastRemoteRawRef = useRef<string | null>(null)
  const lastRemoteScriptRef = useRef<string | null>(null)
  useEffect(() => {
    // 状态更新可能延后执行，先固定本次比较的基线，再推进远端快照。
    const previousRemote = lastRemoteRawRef.current
    setRawDraft((prev) => (previousRemote === null || prev === previousRemote ? remoteRaw : prev))
    lastRemoteRawRef.current = remoteRaw
  }, [remoteRaw])
  useEffect(() => {
    const previousRemote = lastRemoteScriptRef.current
    setScriptDraft((prev) => (previousRemote === null || prev === previousRemote ? remoteScript : prev))
    lastRemoteScriptRef.current = remoteScript
  }, [remoteScript])

  // ===== 首次数据加载：按内容定位剧本步骤（已恢复面板时跳过） =====
  useEffect(() => {
    if (!episode) return
    if (panelRestoredRef.current) {
      panelRestoredRef.current = false
      return
    }
    store.getState().setScriptStep(remoteScript || remoteRaw ? 1 : 0)
     
  }, [episode?.id])

  // ===== 页面加载恢复仍在运行的服务端任务（刷新不丢进度展示） =====
  useEffect(() => {
    if (!episodeId) return
    void (async () => {
      try {
        const st = await episodeApi.extractStatus(episodeId)
        const running = EXTRACT_KEYS.filter((k) => st?.[k]?.status === 'running')
        if (running.length) {
          setExtractWatch(true)
          setExtractingTargets((prev) => [...new Set([...prev, ...running])])
          running.forEach((k) => extractStartedAtRef.current.set(k, Date.now()))
        }
      } catch {
        /* 静默 */
      }
      try {
        const vp = await episodeApi.videoPromptsStatus(episodeId)
        if (vp?.status === 'running') {
          setPromptWatch(true)
          setBatchPromptState({ running: true, total: vp.total || 0, completed: vp.completed || 0 })
        }
      } catch {
        /* 静默 */
      }
    })()
  }, [episodeId])

  // ===== 视频 pending/失败派生（jobs 最新任务按分镜重建 + 本地乐观状态） =====
  const { derivedPending, derivedFail } = useMemo(() => {
    const latestBySb = new Map<number, SysTask>()
    for (const task of jobs.tasks) {
      if (task.type !== 'video' || !task.storyboardId) continue
      const prev = latestBySb.get(task.storyboardId)
      if (
        !prev ||
        String(task.createdAt || '') > String(prev.createdAt || '') ||
        (String(task.createdAt || '') === String(prev.createdAt || '') && task.id > prev.id)
      ) {
        latestBySb.set(task.storyboardId, task)
      }
    }
    const pending = new Set<number>()
    const failed: Record<number, string> = {}
    for (const [sbId, task] of latestBySb) {
      if (hasVid(sbs.find((s) => s.id === sbId))) continue // 失败后重试成功不再报历史错误
      if (task.status === 'processing') pending.add(sbId)
      else if (task.status === 'failed') failed[sbId] = task.errorMsg || t('episode.status.failed')
    }
    return { derivedPending: pending, derivedFail: failed, latestBySb }
  }, [jobs.tasks, sbs, t])

  // 服务端任务记录出现后，清掉对应本地乐观 pending（交给派生状态接管）
  useEffect(() => {
    const optimistic = uiMirror.optimisticPendingVideoIds
    if (!optimistic.length) return
    for (const id of optimistic) {
      if (derivedPending.has(id) || derivedFail[id] != null) {
        store.getState().removeOptimisticPending(id)
      }
    }
  }, [derivedPending, derivedFail, uiMirror.optimisticPendingVideoIds, store])

  const pendingVideoIds = useMemo(() => {
    const merged = new Set(derivedPending)
    for (const id of uiMirror.optimisticPendingVideoIds) {
      if (!derivedFail[id]) merged.add(id)
    }
    return [...merged]
  }, [derivedPending, derivedFail, uiMirror.optimisticPendingVideoIds])

  const videoFailMessages = useMemo(() => {
    const merged: Record<number, string> = { ...derivedFail }
    for (const [idStr, msg] of Object.entries(uiMirror.videoFailMessages)) {
      const id = Number(idStr)
      if (!derivedFail[id]) merged[id] = msg
    }
    return merged
  }, [derivedFail, uiMirror.videoFailMessages])

  const videoStateOf = useCallback(
    (sb: Storyboard | null | undefined): VideoTaskState => {
      if (hasVid(sb)) return 'done'
      if (sb && pendingVideoIds.includes(sb.id)) return 'pending'
      if (sb && videoFailMessages[sb.id]) return 'failed'
      return 'ready'
    },
    [pendingVideoIds, videoFailMessages],
  )

  const videoModerationHint = useCallback(
    (msg: string) => (MODERATION_RE.test(String(msg || '')) ? t('episode.vid.moderationHint') : ''),
    [t],
  )

  // ===== 终态 toast（上一快照 → 新快照；首次快照不提示） =====
  const prevJobStatusRef = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    const prev = prevJobStatusRef.current
    const next = new Map<string, string>()
    for (const task of jobs.tasks) {
      const key = `task-${task.id}`
      const before = prev.get(key)
      if (before && before !== task.status) {
        if (task.status === 'completed') toast.success(t('episode.vid.genDone'))
        else if (task.status === 'failed') toastError(task.errorMsg || t('episode.status.failed'))
      }
      next.set(key, task.status)
    }
    for (const m of jobs.merges) {
      const key = `merge-${m.id}`
      const before = prev.get(key)
      if (before && before !== m.status) {
        if (m.status === 'completed') {
          toast.success(t('episode.export.mergeDone'))
          void queryClient.invalidateQueries({ queryKey: qk.merges(episodeId) })
        } else if (m.status === 'failed') {
          toastError(m.errorMsg, { fallback: 'episode.export.mergeFailed' })
        }
      }
      next.set(key, m.status)
    }
    prevJobStatusRef.current = next
     
  }, [jobs])

  // ===== 生图 pending 跟随查询数据收敛 =====
  const [pendingCharImageIds, setPendingCharImageIds] = useState<number[]>([])
  const [pendingSceneImageIds, setPendingSceneImageIds] = useState<number[]>([])
  const [pendingPropImageIds, setPendingPropImageIds] = useState<number[]>([])
  const settleImagePending = useCallback(
    (list: Array<{ id: number; imageUrl: string }>, setter: (fn: (prev: number[]) => number[]) => void) => {
      setter((prev) => {
        const next = prev.filter((id) => {
          const item = list.find((x) => x.id === id)
          return !!item && !item.imageUrl
        })
        return next.length === prev.length ? prev : next
      })
    },
    [],
  )
  useEffect(() => {
    settleImagePending(chars.map((c) => ({ id: c.id, imageUrl: c.imageUrl })), setPendingCharImageIds)
  }, [chars, settleImagePending])
  useEffect(() => {
    settleImagePending(scenes.map((s) => ({ id: s.id, imageUrl: s.imageUrl })), setPendingSceneImageIds)
  }, [scenes, settleImagePending])
  useEffect(() => {
    settleImagePending(props.map((p) => ({ id: p.id, imageUrl: p.imageUrl })), setPendingPropImageIds)
  }, [props, settleImagePending])

  // 提取完成检测 / 超时放弃
  useEffect(() => {
    const st = extractStatusQuery.data
    if (!st || !extractingTargets.length) return
    for (const target of [...extractingTargets]) {
      const task = st[target as ExtractKey]
      if (task && task.status !== 'running') {
        setExtractingTargets((prev) => prev.filter((x) => x !== target))
        extractStartedAtRef.current.delete(target)
        const label = globalT(`common.${target === 'characters' ? 'role' : target === 'scenes' ? 'scene' : 'prop'}`)
        if (task.status === 'done') {
          toast.success(t('episode.extract.done', { type: label }))
          void queryClient.invalidateQueries({ queryKey: qk.episodeResource(episodeId, 'characters') })
          void queryClient.invalidateQueries({ queryKey: qk.episodeResource(episodeId, 'scenes') })
          void queryClient.invalidateQueries({ queryKey: qk.episodeResource(episodeId, 'props') })
        } else {
          toastError(task.error, { fallback: 'episode.extract.failed' })
        }
      }
    }
    const now = Date.now()
    for (const [target, startedAt] of [...extractStartedAtRef.current]) {
      if (now - startedAt > 375_000) {
        setExtractingTargets((prev) => prev.filter((x) => x !== target))
        extractStartedAtRef.current.delete(target)
      }
    }
     
  }, [extractStatusQuery.data, extractingTargets])

  // 批量提示词：进度刷新 + 终态收敛
  const lastCompletedRef = useRef(0)
  useEffect(() => {
    const st = promptsStatusQuery.data
    if (!st) return
    if (st.status === 'running') {
      setBatchPromptState({ running: true, total: st.total || 0, completed: st.completed || 0 })
      if ((st.completed || 0) !== lastCompletedRef.current) {
        lastCompletedRef.current = st.completed || 0
        void queryClient.invalidateQueries({ queryKey: qk.episodeResource(episodeId, 'storyboards') })
      }
    } else if (batchPromptState.running) {
      setBatchPromptState({ running: false, total: 0, completed: 0 })
      void queryClient.invalidateQueries({ queryKey: qk.episodeResource(episodeId, 'storyboards') })
      if (st.status === 'done') {
        toast.success(st.failed ? t('episode.sb.batchDoneFailed', { n: st.failed }) : t('episode.sb.batchDone'))
      } else {
        toastError(st.error, { fallback: 'episode.sb.batchFailed' })
      }
    }
     
  }, [promptsStatusQuery.data])

  // ===== 动作 =====
  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: qk.dramaDetail(dramaId) })
    if (episodeId > 0) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.episodeResource(episodeId, 'characters') }),
        queryClient.invalidateQueries({ queryKey: qk.episodeResource(episodeId, 'scenes') }),
        queryClient.invalidateQueries({ queryKey: qk.episodeResource(episodeId, 'props') }),
        queryClient.invalidateQueries({ queryKey: qk.episodeResource(episodeId, 'storyboards') }),
        queryClient.invalidateQueries({ queryKey: qk.episodeJobs(episodeId) }),
        queryClient.invalidateQueries({ queryKey: qk.merges(episodeId) }),
      ])
    }
  }, [queryClient, dramaId, episodeId])

  const saveScriptContent = useCallback(
    async (content: string): Promise<boolean> => {
      if (!episodeId) return false
      try {
        await episodeApi.update(episodeId, { script_content: content })
        lastRemoteScriptRef.current = null
        await queryClient.invalidateQueries({ queryKey: qk.dramaDetail(dramaId) })
        return true
      } catch (err) {
        toastError(err)
        return false
      }
    },
    [episodeId, queryClient, dramaId],
  )

  // 保存原文（显式 await，供改写前顺序调用）
  const saveRaw = useCallback(async () => {
    if (!episodeId) return
    await episodeApi.update(episodeId, { content: rawDraft })
    lastRemoteRawRef.current = null
    await queryClient.invalidateQueries({ queryKey: qk.dramaDetail(dramaId) })
  }, [episodeId, rawDraft, queryClient, dramaId])

  // 修正项：显式 await 保存 → 确认成功 → 提交 Agent；保存失败不继续
  const doRewrite = useCallback(async () => {
    if (!episodeId) return
    try {
      await saveRaw()
    } catch (err) {
      toastError(err)
      return
    }
    await runAgent('script_rewriter', '请读取剧本并改写为格式化剧本，然后保存', dramaId, episodeId, () => {
      void refresh()
    }, chatModelOverride(), chatConfigId())
  }, [episodeId, saveRaw, runAgent, dramaId, refresh, chatModelOverride, chatConfigId])

  const skipRewrite = useCallback(() => {
    const raw = (rawDraft || remoteRaw || '').trim()
    if (!raw) {
      toast.warning(t('episode.script.rawRequired'))
      return
    }
    setScriptDraft(raw)
    void (async () => {
      const ok = await saveScriptContent(raw)
      if (!ok) return
      toast.success(t('episode.script.skipDone'))
      store.getState().setStage('production')
      store.getState().setProdTab('assets')
    })()
  }, [rawDraft, remoteRaw, saveScriptContent, t, store])

  const isExtracting = useCallback((target: string) => extractingTargets.includes(target), [extractingTargets])

  const doExtract = useCallback(
    (target: string) => {
      if (extractingTargets.includes(target) || !episodeId) return
      void (async () => {
        // 提取前先保存剧本（与旧行为一致；失败不阻断提取）
        try {
          await episodeApi.update(episodeId, { script_content: scriptDraft })
          lastRemoteScriptRef.current = null
        } catch {
          /* 忽略保存失败 */
        }
        setExtractWatch(true)
        setExtractingTargets((prev) => [...prev, target])
        extractStartedAtRef.current.set(target, Date.now())
        try {
          await episodeApi.extract(episodeId, target as ExtractKey, chatModelOverride(), chatConfigId())
        } catch (err) {
          setExtractingTargets((prev) => prev.filter((x) => x !== target))
          extractStartedAtRef.current.delete(target)
          toastError(err)
        }
      })()
    },
    [extractingTargets, episodeId, scriptDraft, chatModelOverride, chatConfigId],
  )

  const doExtractAll = useCallback(() => {
    for (const key of EXTRACT_KEYS) doExtract(key)
  }, [doExtract])

  const batchVideoPrompts = useCallback(async () => {
    if (batchPromptState.running || !episodeId) return
    if (!sbs.length) {
      toast.warning(t('episode.sb.breakFirst'))
      return
    }
    const st = store.getState()
    const ids = st.videoSelectMode && st.selectedVideoSbIds.length ? [...st.selectedVideoSbIds] : undefined
    try {
      setPromptWatch(true)
      const res = await episodeApi.generateVideoPrompts(episodeId, {
        model: chatModelOverride(),
        configId: chatConfigId(),
        storyboardIds: ids,
      })
      if (!res?.total) {
        if (res?.already_running) {
          setBatchPromptState({ running: true, total: 0, completed: 0 })
        } else {
          toast.info(ids ? t('episode.sb.selectedMissing') : t('episode.sb.allHavePrompts'))
        }
        return
      }
      lastCompletedRef.current = 0
      setBatchPromptState({ running: true, total: res.total ?? 0, completed: 0 })
      toast.info(t('episode.sb.batchStarted', { n: res.total }))
    } catch (err) {
      toastError(err)
    }
  }, [batchPromptState.running, episodeId, sbs.length, store, chatModelOverride, chatConfigId, t])

  const doBreakdown = useCallback(() => {
    if (!episodeId) return
    const msg = breakdownMessage({ chars, scenes, props, videoModelLabel: effectiveVideoModelLabel })
    void runAgent('storyboard_breaker', msg, dramaId, episodeId, () => {
      void (async () => {
        await refresh()
        // 拆分完成后自动补齐缺失的视频提示词（兜住 Agent 漏写/截断）
        const current = queryClient.getQueryData<Storyboard[]>(qk.episodeResource(episodeId, 'storyboards')) ?? []
        if (current.some((sb) => !(sb.videoPrompt || '').trim())) void batchVideoPrompts()
      })()
    }, chatModelOverride(), chatConfigId())
  }, [episodeId, chars, scenes, props, effectiveVideoModelLabel, runAgent, dramaId, refresh, queryClient, batchVideoPrompts, chatModelOverride, chatConfigId])

  const [videoPromptGeneratingIds, setVideoPromptGeneratingIds] = useState<number[]>([])
  const genVideoPrompt = useCallback(
    async (sb: Storyboard) => {
      if (!sb || videoPromptGeneratingIds.includes(sb.id) || !episodeId) return
      const idx = sbs.indexOf(sb) + 1
      const label = selectedVideoConfig ? `${selectedVideoConfig.name} (${selectedVideoConfig.provider})` : '默认'
      const charNames = visualChars.filter((c) => sb.characterIds.includes(c.id)).map((c) => c.name).join('、') || '无'
      const propNames = props.filter((p) => sb.propIds.includes(p.id)).map((p) => p.name).join('、') || '无'
      const scene = storyboardScene(sb, scenes)
      const sceneName = scene ? `${scene.location} · ${scene.time || globalT('episode.asset.noTime')}` : ''
      setVideoPromptGeneratingIds((prev) => [...prev, sb.id])
      try {
        await agentChat('prompt_generator', {
          message: videoPromptMessage({ idx, sbId: sb.id, duration: sb.duration || 10, sceneName, charNames, propNames, videoModelLabel: label }),
          drama_id: dramaId,
          episode_id: episodeId,
          model: chatModelOverride(),
          config_id: chatConfigId(),
        })
        toast.success(t('episode.sb.promptGenerated', { n: idx }))
        await refresh()
      } catch (err) {
        toastError(err)
      } finally {
        setVideoPromptGeneratingIds((prev) => prev.filter((id) => id !== sb.id))
      }
    },
    [videoPromptGeneratingIds, episodeId, sbs, selectedVideoConfig, visualChars, props, scenes, dramaId, chatModelOverride, chatConfigId, refresh, t],
  )

  const [generatingPromptKeys, setGeneratingPromptKeys] = useState<string[]>([])
  const ensureAssetPrompt = useCallback(
    async (kind: AssetKind, id: number, force = false): Promise<string> => {
      const key = `${kind}:${id}`
      if (generatingPromptKeys.includes(key)) return ''
      setGeneratingPromptKeys((prev) => [...prev, key])
      try {
        const res = await assetApiOf(kind).generatePrompt(id, episodeId, force, chatModelOverride(), chatConfigId())
        return res?.final_prompt || ''
      } finally {
        setGeneratingPromptKeys((prev) => prev.filter((k) => k !== key))
      }
    },
    [generatingPromptKeys, episodeId, chatModelOverride, chatConfigId],
  )

  const isGeneratingPrompt = useCallback(
    (kind: AssetKind, id: number) => generatingPromptKeys.includes(`${kind}:${id}`),
    [generatingPromptKeys],
  )

  const genAssetImage = useCallback(
    async (kind: AssetKind, id: number) => {
      if (!episodeId) return
      const setter = kind === 'character' ? setPendingCharImageIds : kind === 'scene' ? setPendingSceneImageIds : setPendingPropImageIds
      const pendingNow = kind === 'character' ? pendingCharImageIds : kind === 'scene' ? pendingSceneImageIds : pendingPropImageIds
      try {
        if (!pendingNow.includes(id)) setter((prev) => [...prev, id])
        const list = kind === 'character' ? chars : kind === 'scene' ? scenes : props
        const item = list.find((x) => x.id === id)
        if (item && !item.finalPrompt) {
          toast.info(t('episode.asset.generatingPrompt'))
          try {
            await ensureAssetPrompt(kind, id)
          } catch {
            /* 提示词生成失败不阻断：后端生图前会再兜底生成或回退本地拼接 */
          }
        }
        await assetApiOf(kind).generateImage(id, {
          episodeId,
          ...imageModelParams(),
          textModel: chatModelOverride(),
          textConfigId: chatConfigId(),
        })
        toast.success(
          t(kind === 'character' ? 'episode.image.generatingChar' : kind === 'scene' ? 'episode.image.generatingScene' : 'episode.image.generatingProp'),
        )
        await refresh()
      } catch (err) {
        setter((prev) => prev.filter((x) => x !== id))
        toastError(err)
      }
    },
    [episodeId, chars, scenes, props, pendingCharImageIds, pendingSceneImageIds, pendingPropImageIds, imageModelParams, ensureAssetPrompt, refresh, t, chatModelOverride, chatConfigId],
  )

  const batchAssetImages = useCallback(
    (kind: AssetKind) => {
      if (!episodeId) return
      const doneLabel = kind === 'character' ? t('episode.image.allCharsDone') : kind === 'scene' ? t('episode.image.allScenesDone') : t('episode.image.allPropsDone')
      const startLabel =
        kind === 'character' ? t('episode.image.batchGeneratingChar') : kind === 'scene' ? t('episode.image.batchGeneratingScene') : t('episode.image.batchGeneratingProp')
      const list = kind === 'character' ? visualChars : kind === 'scene' ? scenes : props
      const ids = list.filter((x) => !x.imageUrl).map((x) => x.id)
      if (!ids.length) {
        toast.info(doneLabel)
        return
      }
      const setter = kind === 'character' ? setPendingCharImageIds : kind === 'scene' ? setPendingSceneImageIds : setPendingPropImageIds
      setter((prev) => [...new Set([...prev, ...ids])])
      const common = {
        episodeId,
        ...imageModelParams(),
        textModel: chatModelOverride(),
        textConfigId: chatConfigId(),
      }
      if (kind === 'character') {
        batchCharacterImages(ids, common)
          .then(() => {
            toast.success(startLabel)
            return refresh()
          })
          .catch((err) => {
            setter((prev) => prev.filter((x) => !ids.includes(x)))
            toastError(err)
          })
      } else {
        ids.forEach((id) => {
          assetApiOf(kind)
            .generateImage(id, common)
            .then(() => refresh())
            .catch((err) => toastError(err))
        })
        toast.success(startLabel)
      }
    },
    [episodeId, visualChars, scenes, props, imageModelParams, refresh, t, chatModelOverride, chatConfigId],
  )

  const [uploadKeys, setUploadKeys] = useState<string[]>([])
  const isUploadingAsset = useCallback((kind: AssetKind, id: number) => uploadKeys.includes(`${kind}:${id}`), [uploadKeys])

  const uploadAssetImage = useCallback(
    (kind: AssetKind, id: number) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp'
      input.onchange = async () => {
        const file = input.files?.[0]
        if (!file) return
        const key = `${kind}:${id}`
        setUploadKeys((prev) => (prev.includes(key) ? prev : [...prev, key]))
        try {
          const res = await uploadApi.image(file)
          // 与生图回写保持一致：存相对路径（static/...），展示时补前导斜杠
          await assetApiOf(kind).update(id, { image_url: res.path, local_path: res.path })
          const typeLabel = globalT(
            kind === 'character' ? 'episode.asset.charPortrait' : kind === 'scene' ? 'episode.asset.sceneImage' : 'episode.asset.propImage',
          )
          toast.success(t('episode.upload.assetDone', { type: typeLabel }))
          await refresh()
        } catch (err) {
          toastError(err)
        } finally {
          setUploadKeys((prev) => prev.filter((k) => k !== key))
        }
      }
      input.click()
    },
    [refresh, t],
  )

  const updateField = useCallback(
    (sb: Storyboard, field: string, value: unknown) => {
      const current = (sb as unknown as Record<string, unknown>)[field]
      if (current === value) return
      storyboardApi
        .update(sb.id, { [field]: value })
        .then(() => queryClient.invalidateQueries({ queryKey: qk.episodeResource(episodeId, 'storyboards') }))
        .catch((err) => toastError(err))
    },
    [queryClient, episodeId],
  )

  const toggleStoryboardCharacter = useCallback(
    (sb: Storyboard, charId: number) => {
      const next = sb.characterIds.includes(charId) ? sb.characterIds.filter((x) => x !== charId) : [...sb.characterIds, charId]
      updateField(sb, 'character_ids', next)
    },
    [updateField],
  )
  const toggleStoryboardProp = useCallback(
    (sb: Storyboard, propId: number) => {
      const next = sb.propIds.includes(propId) ? sb.propIds.filter((x) => x !== propId) : [...sb.propIds, propId]
      updateField(sb, 'prop_ids', next)
    },
    [updateField],
  )
  const toggleSceneBind = useCallback(
    (sb: Storyboard, sceneId: number) => {
      updateField(sb, 'scene_id', sb.sceneId === sceneId ? null : sceneId)
    },
    [updateField],
  )

  const changeEpisodeResolution = useCallback(
    async (val: string) => {
      if (!episode || !episodeId || val === episodeResolution) return
      const prev = episode.resolution
      const patchCache = (resolution: string) =>
        queryClient.setQueryData<Drama>(qk.dramaDetail(dramaId), (d) =>
          d ? { ...d, episodes: d.episodes.map((e) => (e.id === episodeId ? { ...e, resolution } : e)) } : d,
        )
      patchCache(val)
      try {
        await episodeApi.update(episodeId, { resolution: val })
        toast.success(t('episode.vid.resolutionSwitched', { label: resolutionShort(resolutionProvider, val) }))
      } catch (err) {
        patchCache(prev)
        toastError(err)
      }
    },
    [episode, episodeId, episodeResolution, queryClient, dramaId, t, resolutionProvider],
  )

  const genVid = useCallback(
    async (sb: Storyboard, opts: { silent?: boolean } = {}) => {
      const st = store.getState()
      const referenceImages = getShotReferenceImages(sb, visualChars, scenes, props, refImageLimit)
      const prompt = resolveVideoPromptRefs(sb, visualChars, scenes, props, refImageLimit)
      if (!prompt && !referenceImages.length) {
        toast.error(t('episode.vid.needRefOrPrompt'))
        return
      }
      const vm = videoModelParams()
      try {
        st.setVideoFailMessage(sb.id, null)
        st.addOptimisticPending(sb.id)
        await taskApi.generate({
          type: 'video',
          storyboard_id: sb.id,
          drama_id: dramaId,
          prompt,
          duration: Number(sb.duration || 10),
          aspect_ratio: dramaAspectRatio,
          generate_audio: true,
          model: vm.model,
          config_id: vm.configId,
          reference_image_urls: referenceImages,
        })
        if (!opts.silent) toast.success(t('episode.vid.generating'))
        await refresh()
      } catch (err) {
        st.removeOptimisticPending(sb.id)
        st.setVideoFailMessage(sb.id, (err as Error)?.message || t('episode.vid.genFailed'))
        toastError(err, { fallback: 'episode.vid.genFailed' })
      }
    },
    [store, visualChars, scenes, props, refImageLimit, videoModelParams, dramaId, dramaAspectRatio, refresh, t],
  )

  const openBatchVideoConfirm = useCallback(
    (pool: Storyboard[]) => {
      const st = store.getState()
      const targets = pool.filter((s) => !st.optimisticPendingVideoIds.includes(s.id) && videoStateOf(s) !== 'pending')
      if (!targets.length) {
        toast.info(t('episode.vid.noneToGenerate'))
        return
      }
      setBatchConfirmTargets(targets)
    },
    [store, videoStateOf, t],
  )

  const retryFailedVideos = useCallback(() => {
    openBatchVideoConfirm(sbs.filter((s) => videoStateOf(s) === 'failed'))
  }, [openBatchVideoConfirm, sbs, videoStateOf])

  const confirmBatchVideos = useCallback(() => {
    const st = store.getState()
    const targets = batchConfirmTargets ?? []
    setBatchConfirmTargets(null)
    if (!targets.length) return
    targets.forEach((sb) => void genVid(sb, { silent: true }))
    toast.success(t('episode.vid.batchStarted', { n: targets.length }))
    if (st.videoSelectMode) st.toggleVideoSelectMode()
  }, [batchConfirmTargets, genVid, t, store])

  const doMerge = useCallback(
    async (ids?: number[]) => {
      if (!episodeId) return
      const storyboardIds = Array.isArray(ids) ? ids : undefined
      if (storyboardIds && !storyboardIds.length) {
        toast.error(t('episode.export.selectFirst'))
        return
      }
      try {
        await mergeApi.merge(episodeId, storyboardIds)
        toast.success(t('episode.export.mergingToast'))
        await queryClient.invalidateQueries({ queryKey: qk.episodeJobs(episodeId) })
        // 拼接终态提示与成片列表刷新由 jobs 转移检测统一处理
      } catch (err) {
        toastError(err, { fallback: 'episode.export.mergeFailed' })
      }
    },
    [episodeId, queryClient, t],
  )

  const refreshExportMerges = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: qk.merges(episodeId) })
  }, [queryClient, episodeId])

  const toggleExportDone = useCallback(async () => {
    if (!episodeId || !episode) return
    const status = episode.status === 'completed' ? 'active' : 'completed'
    try {
      await episodeApi.update(episodeId, { status })
      await queryClient.invalidateQueries({ queryKey: qk.dramaDetail(dramaId) })
      toast.success(status === 'completed' ? t('episode.export.markedDoneToast') : t('episode.export.unmarkDoneToast'))
    } catch (err) {
      toastError(err)
    }
  }, [episodeId, episode, queryClient, dramaId, t])

  const onVideoDurationChange = useCallback(
    (sb: Storyboard, raw: string) => {
      let v = Math.round(Number(raw))
      if (!Number.isFinite(v)) v = Number(sb.duration || 10)
      // 统一限制 2-30s；超出厂商支持范围由后端适配器收敛
      v = Math.min(30, Math.max(2, v))
      updateField(sb, 'duration', v)
    },
    [updateField],
  )

  const getSceneName = useCallback(
    (sb: Storyboard) => {
      const scene = storyboardScene(sb, scenes)
      if (!scene) return ''
      return `${scene.location} · ${scene.time || t('episode.asset.noTime')}`
    },
    [scenes, t],
  )

  const shotReferenceImages = useCallback(
    (sb: Storyboard) => getShotReferenceImages(sb, visualChars, scenes, props, refImageLimit),
    [visualChars, scenes, props, refImageLimit],
  )

  const shotReferenceIndexMap = useCallback(
    (sb: Storyboard) => {
      // 与 getShotReferenceImages 同口径（场景→角色→道具、去重、上限内）
      return buildIndexMap(sb, visualChars, scenes, props, refImageLimit)
    },
    [visualChars, scenes, props, refImageLimit],
  )

  const videoPromptRefs = useCallback(
    (sb: Storyboard) => resolveVideoPromptRefs(sb, visualChars, scenes, props, refImageLimit),
    [visualChars, scenes, props, refImageLimit],
  )

  const saveAssetCreate = useCallback(
    async (type: AssetKind, draft: Record<string, string>) => {
      const base = { drama_id: dramaId, episode_id: episodeId }
      if (type === 'character') await assetApiOf('character').create({ ...base, name: draft.name, role: draft.role, appearance: draft.appearance, styling: draft.styling })
      else if (type === 'scene') await assetApiOf('scene').create({ ...base, location: draft.location, time: draft.time, prompt: draft.prompt, lighting: draft.lighting })
      else await assetApiOf('prop').create({ ...base, name: draft.name, type: draft.type, description: draft.description })
      await refresh()
    },
    [dramaId, episodeId, refresh],
  )

  const deleteAsset = useCallback(
    async (type: AssetKind, id: number) => {
      await assetApiOf(type).del(id)
      await refresh()
    },
    [refresh],
  )

  const setVideoCols = useCallback(
    (cols: { left: number; right: number }) => {
      prefs.setVideoColumns({ left: clampVideoCol('left', cols.left), right: clampVideoCol('right', cols.right) })
    },
    [prefs],
  )

  const extractingLabel = useMemo(
    () =>
      extractingTargets
        .map((k) => globalT(`common.${k === 'characters' ? 'role' : k === 'scenes' ? 'scene' : 'prop'}`))
        .join(globalT('common.listJoin')),
    [extractingTargets],
  )

  const value: WorkbenchContextValue = {
    dramaId,
    episodeNumber,
    dramaError: (dramaQuery.error as Error | null) ?? null,
    drama: dramaQuery.data,
    episode,
    episodeId,
    chars,
    scenes,
    props,
    sbs,
    visualChars,
    exportMerges,
    jobs,
    ready: !!dramaQuery.data && !!episode,
    agentRunning,
    agentRunningType,
    textModelOptions,
    imageModelOptions,
    videoModelOptions,
    textModelMultiCfg: hasMultiConfigs(textModelOptions),
    imageModelMultiCfg: hasMultiConfigs(imageModelOptions),
    videoModelMultiCfg: hasMultiConfigs(videoModelOptions),
    selectedVideoConfig,
    effectiveVideoModelLabel,
    resolutionProvider,
    episodeResolution,
    dramaAspectRatio,
    refImageLimit,
    videoCols: prefs.videoColumns,
    setVideoCols,
    batchPrompt: batchPromptState,
    extractingTargets,
    extractingLabel,
    pendingCharImageIds,
    pendingSceneImageIds,
    pendingPropImageIds,
    pendingVideoIds,
    videoFailMessages,
    videoStateOf,
    videoModerationHint,
    videoPromptGeneratingIds,
    uploadKeys,
    generatingPromptKeys,
    totalDuration,
    rawDraft,
    setRawDraft,
    scriptDraft,
    setScriptDraft,
    refresh,
    saveRaw,
    doRewrite,
    skipRewrite,
    doExtract,
    doExtractAll,
    isExtracting,
    batchVideoPrompts,
    doBreakdown,
    genVideoPrompt,
    genAssetImage,
    batchAssetImages,
    uploadAssetImage,
    isUploadingAsset,
    ensureAssetPrompt,
    isGeneratingPrompt,
    updateField,
    toggleStoryboardCharacter,
    toggleStoryboardProp,
    toggleSceneBind,
    changeEpisodeResolution,
    genVid,
    batchConfirmTargets,
    openBatchVideoConfirm,
    retryFailedVideos,
    confirmBatchVideos,
    closeBatchConfirm: () => setBatchConfirmTargets(null),
    doMerge,
    refreshExportMerges,
    toggleExportDone,
    onVideoDurationChange,
    chatModelOverride,
    chatConfigId,
    imageModelParams,
    videoModelParams,
    getSceneName,
    shotReferenceImages,
    shotReferenceIndexMap,
    videoPromptRefs,
    saveAssetCreate,
    deleteAsset,
  }

  return (
    <WorkbenchContext.Provider value={value}>
      <WorkbenchStoreProvider store={store}>{children}</WorkbenchStoreProvider>
    </WorkbenchContext.Provider>
  )
}

/** 与 getShotReferenceImages 同口径（场景→角色→道具、去重、上限内）的 @名字 序号映射 */
function buildIndexMap(
  sb: Storyboard,
  chars: Character[],
  scenes: Scene[],
  props: Prop[],
  limit: number,
): Record<string, number> {
  const ordered: { name: string; imageUrl: string }[] = []
  const seen = new Set<string>()
  const push = (name: string, url: string | null | undefined) => {
    if (!url || seen.has(url) || ordered.length >= limit) return
    seen.add(url)
    ordered.push({ name, imageUrl: url })
  }
  const scene = storyboardScene(sb, scenes)
  if (scene) push(scene.location || '', scene.imageUrl)
  for (const char of chars) {
    if (sb.characterIds.includes(char.id)) push(char.name || '', char.imageUrl)
  }
  for (const prop of props) {
    if (sb.propIds.includes(prop.id)) push(prop.name || '', prop.imageUrl)
  }
  const nameToIndex: Record<string, number> = {}
  ordered.forEach((a, i) => {
    if (a.name && !(a.name in nameToIndex)) nameToIndex[a.name] = i + 1
  })
  return nameToIndex
}
