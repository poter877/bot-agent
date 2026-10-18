/**
 * 工作台作用域 store：每个剧集一个实例（createStore 工厂 + Context 传递），
 * 只保存交互状态（面板/选中/勾选/抽屉）与生成中的临时跟踪，不持有实体数据
 * （实体详情一律从 Query 数据派生）。不持久化——面板记忆在全局 preferences。
 */
import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react'
import { createStore, useStore } from 'zustand'

export type Stage = 'script' | 'production' | 'export'
export type ProdTab = 'assets' | 'videos'

export interface WorkbenchState {
  /** 当前大面板 */
  stage: Stage
  /** 剧本子步骤：0=原文 1=改写 */
  scriptStep: number
  prodTab: ProdTab
  /** 当前选中分镜（列表单选与检查器共用） */
  selectedStoryboardId: number | null
  /** 视频列表筛选：'' = 全部 */
  videoListFilter: '' | 'pending' | 'done' | 'failed'
  videoSelectMode: boolean
  selectedVideoSbIds: number[]
  taskDrawerOpen: boolean
  /** 导出镜头勾选（仅含有效视频的 id） */
  exportSelectedIds: number[]
  /** 用户手动操作过导出勾选后，不再自动全选 */
  exportSelTouched: boolean
  /** 提交受理后、任务记录尚未加载出来的本地乐观 pending（避免状态闪退） */
  optimisticPendingVideoIds: number[]
  /** 提交失败/轮询超时的本地错误（服务端 failed 记录恢复后覆盖） */
  videoFailMessages: Record<number, string>
  setStage: (stage: Stage) => void
  setScriptStep: (step: number) => void
  setProdTab: (tab: ProdTab) => void
  selectStoryboard: (id: number | null) => void
  setVideoListFilter: (f: WorkbenchState['videoListFilter']) => void
  toggleVideoSelectMode: () => void
  setSelectedVideoSbIds: (ids: number[]) => void
  toggleVideoSbSelect: (id: number) => void
  setTaskDrawerOpen: (open: boolean) => void
  setExportSelectedIds: (ids: number[]) => void
  markExportSelTouched: () => void
  addOptimisticPending: (id: number) => void
  removeOptimisticPending: (id: number) => void
  setVideoFailMessage: (id: number, msg: string | null) => void
}

export function createWorkbenchStore(init?: Partial<Pick<WorkbenchState, 'stage' | 'scriptStep' | 'prodTab'>>) {
  return createStore<WorkbenchState>()((set) => ({
    stage: init?.stage ?? 'script',
    scriptStep: init?.scriptStep ?? 0,
    prodTab: init?.prodTab ?? 'assets',
    selectedStoryboardId: null,
    videoListFilter: '',
    videoSelectMode: false,
    selectedVideoSbIds: [],
    taskDrawerOpen: false,
    exportSelectedIds: [],
    exportSelTouched: false,
    optimisticPendingVideoIds: [],
    videoFailMessages: {},
    setStage: (stage) => set({ stage }),
    setScriptStep: (scriptStep) => set({ scriptStep }),
    setProdTab: (prodTab) => set({ prodTab }),
    selectStoryboard: (selectedStoryboardId) => set({ selectedStoryboardId }),
    setVideoListFilter: (videoListFilter) => set({ videoListFilter }),
    toggleVideoSelectMode: () =>
      set((s) => ({ videoSelectMode: !s.videoSelectMode, selectedVideoSbIds: s.videoSelectMode ? [] : s.selectedVideoSbIds })),
    setSelectedVideoSbIds: (selectedVideoSbIds) => set({ selectedVideoSbIds }),
    toggleVideoSbSelect: (id) =>
      set((s) => ({
        selectedVideoSbIds: s.selectedVideoSbIds.includes(id)
          ? s.selectedVideoSbIds.filter((x) => x !== id)
          : [...s.selectedVideoSbIds, id],
      })),
    setTaskDrawerOpen: (taskDrawerOpen) => set({ taskDrawerOpen }),
    setExportSelectedIds: (exportSelectedIds) => set({ exportSelectedIds }),
    markExportSelTouched: () => set({ exportSelTouched: true }),
    addOptimisticPending: (id) =>
      set((s) => ({
        optimisticPendingVideoIds: s.optimisticPendingVideoIds.includes(id) ? s.optimisticPendingVideoIds : [...s.optimisticPendingVideoIds, id],
      })),
    removeOptimisticPending: (id) =>
      set((s) => ({ optimisticPendingVideoIds: s.optimisticPendingVideoIds.filter((x) => x !== id) })),
    setVideoFailMessage: (id, msg) =>
      set((s) => {
        const next = { ...s.videoFailMessages }
        if (msg == null) delete next[id]
        else next[id] = msg
        return { videoFailMessages: next }
      }),
  }))
}

const WorkbenchStoreContext = createContext<ReturnType<typeof createWorkbenchStore> | null>(null)

export function WorkbenchStoreProvider({ store, children }: { store: ReturnType<typeof createWorkbenchStore>; children: ReactNode }) {
  return createElement(WorkbenchStoreContext.Provider, { value: store }, children)
}

export function useWorkbenchStore<T>(selector: (state: WorkbenchState) => T): T {
  const store = useContext(WorkbenchStoreContext)
  if (!store) throw new Error('useWorkbenchStore must be used within WorkbenchStoreProvider')
  return useStore(store, selector)
}

export function useWorkbenchStoreInstance() {
  const store = useContext(WorkbenchStoreContext)
  if (!store) throw new Error('useWorkbenchStoreInstance must be used within WorkbenchStoreProvider')
  return store
}

/** 便捷：工作台组件内的 store 读取（多字段稳定 selector 由调用方 useShallow 或分别订阅） */
export function useWorkbenchState() {
  const store = useWorkbenchStoreInstance()
  return useMemo(() => store, [store])
}
