/**
 * 项目 ↔ Agent 会话关联（《重构》方案 §5）。
 *
 * 每个创作项目（短剧/创意视频）一条独立宿主会话：多轮创作上下文连续、
 * 不同项目互不串扰、也不混入普通聊天（会话由宿主 serve 持有，天然隔离）。
 * 映射存 localStorage（前端展示缓存；会话真相在宿主——映射丢失时新建会话
 * 即可，历史仍可从宿主找回）。
 *
 * storedSessionId 用于持久化恢复；runtime sessionId 用于当次连接控制。
 */
const STORAGE_KEY = 'huobao:studio-agent-sessions'

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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
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
