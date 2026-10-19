/**
 * 用户会话 — 复用公司后端（bot-backend）的 Better Auth 账号体系。
 *
 * 启用条件：配置了 COMPANY_BACKEND_URL 且未显式关闭（AI_DRAMA_REQUIRE_LOGIN=false）。
 * 未启用时 /api/v1 维持旧行为（共享令牌 + 回环放行，见 middleware/api-auth.ts）。
 *
 * 校验方式：把浏览器会话 Cookie 转发给公司后端 /api/auth/get-session；
 * 结果按 Cookie 哈希缓存 60 秒（热路径不打公司后端）。网络异常按未登录处理
 * （fail-closed）。env 惰性读取：与 company-backend.ts 同因（ESM 导入序）。
 */
import { createHash } from 'node:crypto'
import { companyBackendUrl } from './company-backend.js'

export interface SessionUser {
  id: string
  email: string
}

const SESSION_TTL_MS = 60_000
const cache = new Map<string, { user: SessionUser | null; at: number }>()

export function userAuthEnabled(): boolean {
  if ((process.env.AI_DRAMA_REQUIRE_LOGIN || '').trim().toLowerCase() === 'false') return false
  return !!companyBackendUrl()
}

export async function lookupSession(cookie: string): Promise<SessionUser | null> {
  if (!cookie) return null
  const key = createHash('sha1').update(cookie).digest('hex')
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < SESSION_TTL_MS) return hit.user
  let user: SessionUser | null = null
  try {
    const res = await fetch(`${companyBackendUrl()}/api/auth/get-session`, {
      headers: { cookie },
      signal: AbortSignal.timeout(8_000),
    })
    if (res.ok) {
      const body = (await res.json()) as { user?: { id?: string; email?: string } } | null
      if (body?.user?.id && body.user.email) user = { id: body.user.id, email: body.user.email }
    }
  } catch {
    /* 网络异常按未登录处理 */
  }
  if (cache.size > 500) cache.clear()
  cache.set(key, { user, at: Date.now() })
  return user
}

/** 测试隔离：清空会话缓存 */
export function resetSessionCache(): void {
  cache.clear()
}
