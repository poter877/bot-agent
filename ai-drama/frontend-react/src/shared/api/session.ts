/**
 * 用户会话探测 — 登录模式的唯一判定入口。
 *
 * /api/v1/auth/session 由后端代理到公司后端（bot-backend / Better Auth）：
 * - 200 + user → 已登录
 * - 200 + null → 登录模式、未登录（跳 /login）
 * - 503/404 → 未配置公司后端，维持旧模式（共享令牌/回环），不启用登录页
 *
 * mode 模块级缓存：路由守卫启动时探测一次，client.ts 的 401 处理据此分流
 * （登录模式跳 /login；旧模式广播给 ApiTokenGate 弹令牌输入）。
 */

export type SessionMode = 'login' | 'legacy'

export interface SessionUser {
  id: string
  email: string
  name?: string
}

import { studioHost } from '@/shared/studio/host'

let cachedMode: SessionMode | null = null

export function sessionMode(): SessionMode | null {
  return cachedMode
}

export async function probeSession(): Promise<{ mode: SessionMode; user: SessionUser | null }> {
  // 嵌入模式：账号状态来自宿主登录门（StudioHost 注入方），不再二次登录。
  const host = studioHost()
  if (host) {
    const { authenticated, user } = await host.account.status()
    cachedMode = 'login'
    return { mode: 'login', user: authenticated && user ? { id: user.id, email: user.email, name: user.name } : null }
  }

  let user: SessionUser | null = null
  let mode: SessionMode = 'legacy'
  try {
    const res = await fetch('/api/auth/get-session', { credentials: 'include' })
    if (res.ok) {
      mode = 'login'
      const body = (await res.json()) as { user?: { id?: string; email?: string; name?: string } } | null
      if (body?.user?.id && body.user.email) {
        user = { id: body.user.id, email: body.user.email, name: body.user.name }
      }
    }
  } catch {
    /* 后端不可达按旧模式（ApiTokenGate/错误面兜底） */
  }
  cachedMode = mode
  return { mode, user }
}
