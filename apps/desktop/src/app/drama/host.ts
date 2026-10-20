/**
 * StudioHost 的桌面实现 —— 视频工厂内嵌页的宿主通道（《重构》方案 §4/§7）。
 *
 * business.request 走 hermesDesktop.api（Electron IPC → main → 本地 serve 的
 * /api/plugins/video-studio/ 插件路由 → 账号桥 → bot-backend），全程同进程
 * 链路：无 CORS、无 Vite 代理依赖、凭据不出宿主。IPC 对后端 ≥400 会 reject
 * 带 statusCode 的错误——这里还原成标准 Response，前端现有的 401/错误处理
 * 分支原样复用。
 */
import type { StudioHost } from '@drama/shared/studio/host'

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

export function createDesktopStudioHost(): StudioHost {
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
      // P1 后续接票据化媒体通道；首期透传相对路径，行为与现状一致。
      resolveUrl(path) {
        return path
      }
    }
  }
}
