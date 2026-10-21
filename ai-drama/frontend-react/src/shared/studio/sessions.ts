/**
 * 项目 ↔ Agent 会话关联（《重构》方案 §5）。
 *
 * 每个创作项目（短剧/视频制片）一条独立宿主会话：多轮创作上下文连续、
 * 不同项目互不串扰、也不混入普通聊天（会话由宿主 serve 持有，天然隔离）。
 * 映射存 localStorage（前端展示缓存；会话真相在宿主——映射丢失时新建会话
 * 即可，历史仍可从宿主找回）。
 *
 * storedSessionId 用于持久化恢复；runtime sessionId 用于当次连接控制。
 */
// 版本前缀：映射结构演进时旧数据自然失效（当作无关联 → 新建会话即可，
// 会话真相在宿主侧，丢失无损）；写入容错：隐私模式/配额超限时静默降级。
const STORAGE_VERSION = 'v1'
const STORAGE_KEY = `vf:studio-agent-sessions:${STORAGE_VERSION}`

type ProjectKey = string // `drama:<id>` | `creative:<id>`

interface Association {
  sessionId: string
  storedSessionId?: string
  updatedAt: number
}

function readAll(): Record<ProjectKey, Association> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Record<ProjectKey, Association>
  } catch {
    return {}
  }
}

function writeAll(map: Record<ProjectKey, Association>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // 隐私模式/配额超限/存储被禁：降级为仅内存（本页有效，关页即弃）
  }
}

export const studioSessions = {
  key: (kind: 'creative' | 'drama', id: number | string): ProjectKey => `${kind}:${id}`,

  get(key: ProjectKey): Association | null {
    return readAll()[key] ?? null
  },

  set(key: ProjectKey, assoc: { sessionId: string; storedSessionId?: string }): void {
    const all = readAll()
    all[key] = { ...assoc, updatedAt: Date.now() }
    writeAll(all)
  },

  clear(key: ProjectKey): void {
    const all = readAll()
    delete all[key]
    writeAll(all)
  },

  /** 会话标题：宿主会话列表里一眼可辨（也用于普通聊天与工作室会话的视觉分界） */
  title(projectTitle: string): string {
    return `视频工厂 · ${projectTitle}`
  }
}
