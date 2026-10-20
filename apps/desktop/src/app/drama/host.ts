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
import type { StudioHost } from '@drama/shared/studio/host'

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

export function createDesktopStudioHost(conn: DesktopStudioConnection): StudioHost {
  return {
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
}
