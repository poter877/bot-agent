import type { StudioAgentEvent, StudioHost } from '@drama/shared/studio/host'
/**
 * StudioHost 的桌面实现 —— 视频工厂内嵌页的宿主通道（《重构》方案 §4/§7）。
 *
 * business.request 走 hermesDesktop.api（Electron IPC → main → 本地 serve 的
 * /api/plugins/video-studio/ 插件路由 → 账号桥 → bot-backend），全程同进程
 * 链路：无 CORS、无 Vite 代理依赖、凭据不出宿主。IPC 对后端 ≥400 会 reject
 * 带 statusCode 的错误——这里还原成标准 Response，前端现有的 401/错误处理
 * 分支原样复用。
 *
 * business.upload 与 assets.resolveUrl 用渲染进程对 serve 的直接 HTTP（携带
 * serve 的会话令牌）：multipart 与 Range 流不适合 IPC 的 JSON 往返——大文件
 * 全程 HTTP 流式，正是方案 §7 要求的通道。连接信息在挂载时预取一次（宿主
 * 工厂是同步纯函数，见 page.tsx 的装配顺序）。
 */
import { JsonRpcGatewayClient } from '@hermes/shared'

export interface DesktopStudioConnection {
  baseUrl: string
  token: string
}

function errorToResponse(error: unknown): Response {
  const status = Number(
    error && typeof error === 'object' ? (error as { statusCode?: unknown }).statusCode : NaN
  )

  const message = error instanceof Error ? error.message : String(error)

  if (Number.isInteger(status) && status > 0) {
    // "<status>: <body>" — body 是后端原文（插件层透传的 JSON 错误体）
    const prefixed = `${status}: `
    const body = message.startsWith(prefixed) ? message.slice(prefixed.length) : message

    return new Response(body, { status, headers: { 'Content-Type': 'application/json' } })
  }

  return new Response(JSON.stringify({ error: message }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' }
  })
}

/**
 * 工作室专属的 Agent 车道：一条独立于桌面主 UI 的 JSON-RPC 连接（自己的
 * requestIdPrefix），会话创建/提交/事件流/打断全部走它。独立连接让工作室
 * 的订阅与桌面聊天的订阅互不干扰（会话本身也天然隔离，不串普通聊天）。
 */
class StudioAgentLane {
  private client: JsonRpcGatewayClient
  private handlers = new Set<(event: StudioAgentEvent) => void>()
  private ready: Promise<void>

  constructor(wsUrl: string) {
    this.client = new JsonRpcGatewayClient({ requestIdPrefix: 'studio' })
    this.client.onAny(event => {
      const forwarded: StudioAgentEvent = {
        type: event.type,
        sessionId: (event as { session_id?: string }).session_id,
        payload: (event as { payload?: unknown }).payload
      }

      for (const handler of this.handlers) {
        handler(forwarded)
      }
    })
    this.ready = this.client.connect(wsUrl)
  }

  async createSession(opts: { title?: string; idempotencyKey?: string }) {
    await this.ready

    return this.client.request('session.create', {
      source: 'desktop',
      title: opts.title,
      ...(opts.idempotencyKey ? { idempotency_key: opts.idempotencyKey } : {})
    }) as Promise<{ session_id: string; stored_session_id?: string }>
  }

  async submit(sessionId: string, text: string) {
    await this.ready

    return this.client.request('prompt.submit', { session_id: sessionId, text }) as Promise<{ status?: string }>
  }

  async interrupt(sessionId: string) {
    await this.ready
    await this.client.request('session.interrupt', { session_id: sessionId })
  }

  async history(sessionId: string) {
    await this.ready

    const r = await this.client.request('session.history', { session_id: sessionId }) as {
      messages?: Array<{ role: string; text?: string | null }>
    }

    return (r.messages ?? []).map(m => ({ role: m.role, text: m.text }))
  }

  onEvent(handler: (event: StudioAgentEvent) => void) {
    this.handlers.add(handler)

    return () => {
      this.handlers.delete(handler)
    }
  }

  dispose() {
    this.client.close()
  }
}

export interface DesktopStudioHandle {
  host: StudioHost
  /** 页面卸载时释放 lane 的 ws 订阅。会话本身继续活在 serve 上（切换页面
   *  不取消 Agent）；app 退出由 Electron 既有受管清理带走自有 serve。 */
  dispose: () => void
}

export function createDesktopStudioHost(conn: DesktopStudioConnection): DesktopStudioHandle {
  const agentLane = new StudioAgentLane(`${conn.baseUrl.replace(/^http/, 'ws')}/api/ws?token=${encodeURIComponent(conn.token)}`)

  const host: StudioHost = {
    business: {
      async request(path, init) {
        const method = init?.method ?? (init?.body !== undefined ? 'POST' : 'GET')

        try {
          const data = await window.hermesDesktop.api<unknown>({
            // 插件路由固定挂载在 serve 的 /api/plugins/video-studio/ 下
            path: `/api/plugins/video-studio/${path.replace(/^\/+/, '')}`,
            method,
            ...(init?.body !== undefined ? { body: init.body } : {})
          })

          return new Response(JSON.stringify(data ?? null), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        } catch (error) {
          return errorToResponse(error)
        }
      },

      async upload(path, file, signal) {
        const fd = new FormData()
        fd.append('file', file)

        // 插件的 /upload/... 通道：multipart 原样转发（fetch 可带令牌 header）
        return fetch(`${conn.baseUrl}/api/plugins/video-studio/upload${path.replace(/^\/+/, '')}`, {
          method: 'POST',
          headers: { 'X-Hermes-Session-Token': conn.token },
          body: fd,
          signal
        })
      }
    },
    account: {
      async status() {
        try {
          const data = await window.hermesDesktop.api<{ authenticated?: boolean; user?: unknown }>({
            path: '/api/plugins/video-studio/api/auth/get-session',
            method: 'GET'
          })

          const user = data && typeof data === 'object' && 'user' in data ? (data as { user: unknown }).user : null

          if (user && typeof user === 'object' && 'id' in user) {
            const u = user as { id?: unknown; email?: unknown; name?: unknown }

            return {
              authenticated: true,
              user: {
                id: String(u.id ?? ''),
                email: String(u.email ?? ''),
                name: typeof u.name === 'string' ? u.name : undefined
              }
            }
          }

          return { authenticated: false, user: null }
        } catch {
          return { authenticated: false, user: null }
        }
      }
    },
    agent: {
      async createSession(opts) {
        const r = await agentLane.createSession(opts)

        return { sessionId: r.session_id, storedSessionId: r.stored_session_id }
      },
      submit: (sessionId, text) => agentLane.submit(sessionId, text),
      interrupt: sessionId => agentLane.interrupt(sessionId),
      history: sessionId => agentLane.history(sessionId),
      onEvent: handler => agentLane.onEvent(handler)
    },
    assets: {
      resolveUrl(path) {
        // 媒体标签（<img>/<video>）带不了 header——/static/... 改走插件的
        // /media/ 通道 + query token（serve 对该前缀开了窄白名单）。
        if (path.startsWith('/static/')) {
          const media = path.slice('/static/'.length)

          return `${conn.baseUrl}/api/plugins/video-studio/media/${media}?token=${encodeURIComponent(conn.token)}`
        }

        return path
      }
    }
  }

  return { host, dispose: () => agentLane.dispose() }
}
