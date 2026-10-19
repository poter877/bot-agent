/**
 * /api/v1 鉴权 — 挡住「能摸到 30171 就能花公司额度/读工作区」的裸奔面。
 *
 * 两种模式（fail-closed 为主）：
 * 1. 用户会话模式（配置 COMPANY_BACKEND_URL 且未设 AI_DRAMA_REQUIRE_LOGIN=false）：
 *    浏览器请求凭公司后端（bot-backend / Better Auth）的会话 Cookie 进入，
 *    校验结果缓存 60 秒（services/user-session.ts）；回环不再无条件放行。
 *    Bearer AI_DRAMA_API_TOKEN 仍是服务调用方（部署网关/巡检）的旁路。
 * 2. 旧共享令牌模式（未配置公司后端）：
 *    - 配置了 AI_DRAMA_API_TOKEN：必须 Bearer 匹配；比较走 sha256 +
 *      timingSafeEqual（长度不泄露）。
 *    - 未配置：仅放行回环来源，非回环 401（本地 dev/桌面壳零配置可用）。
 *
 * 豁免：/api/v1/health（部署巡检探活）、/api/v1/auth/*（登录代理自身）、
 * /mcp（自带 AI_DRAMA_MCP_TOKEN 校验，不双重 gating）、前端静态产物与 /static
 * 媒体（uuid 命名不可枚举，且 <img> 无法带 Authorization 头）。
 * 不信任 X-Forwarded-For（未配置可信反代时任意可伪造）。
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { lookupSession, userAuthEnabled } from '../services/user-session.js'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context, MiddlewareHandler } from 'hono'

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function bearerToken(c: Context): string | null {
  const header = c.req.header('authorization')
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token || null
}

/** 常量时间比较（先哈希抹平长度差，与 mcp/route.ts 同一写法） */
function tokenMatches(got: string, expected: string): boolean {
  const a = createHash('sha256').update(expected).digest()
  const b = createHash('sha256').update(got).digest()
  return timingSafeEqual(a, b)
}

/** 测试环境（app.request）没有真实 socket，getConnInfo 会抛错 → 视为不可判定 */
function remoteAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address
  } catch {
    return undefined
  }
}

export const apiAuth: MiddlewareHandler = async (c, next) => {
  if (c.req.path === '/api/v1/health' || c.req.path.startsWith('/api/v1/auth/')) return next()

  const expected = process.env.AI_DRAMA_API_TOKEN?.trim()
  if (expected) {
    const got = bearerToken(c)
    if (got && tokenMatches(got, expected)) return next()
    if (!got && await lookupSession(c.req.header('cookie') ?? '')) return next()
    if (userAuthEnabled()) {
      return c.json({ code: 401, message: '未登录或会话已过期，请先登录', login: true }, 401)
    }
    return c.json({ code: 401, message: 'Unauthorized: missing or invalid Authorization: Bearer token (AI_DRAMA_API_TOKEN)' }, 401)
  }

  // 用户会话模式：浏览器凭公司后端会话进入；回环不再无条件放行。
  if (userAuthEnabled()) {
    if (await lookupSession(c.req.header('cookie') ?? '')) return next()
    return c.json({ code: 401, message: '未登录或会话已过期，请先登录', login: true }, 401)
  }

  const remote = remoteAddress(c)
  if (remote && LOOPBACK_ADDRESSES.has(remote)) return next()
  return c.json({
    code: 401,
    message: 'Unauthorized: server is reachable from a non-loopback address; configure AI_DRAMA_API_TOKEN and send it as Authorization: Bearer',
  }, 401)
}
