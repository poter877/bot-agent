/**
 * /api/v1 共享令牌鉴权 — 挡住「能摸到 5679 就能花公司额度/读工作区」的裸奔面。
 *
 * 行为（fail-closed 为主，本地开发零配置可用）：
 * - 配置了 AI_DRAMA_API_TOKEN：所有 /api/v1 请求（/health 除外）必须带
 *   `Authorization: Bearer <token>` 且匹配，否则 401。与 AI_DRAMA_MCP_TOKEN
 *   分开命名（可同值部署）；比较走 sha256 + timingSafeEqual（长度不泄露）。
 * - 未配置：仅放行回环来源（127.0.0.1 / ::1 / ::ffff:127.0.0.1），非回环 401。
 *   本地 dev（浏览器 → localhost）与桌面壳（127.0.0.1 随机端口）零配置不受影响；
 *   容器/公网部署下外部请求的 remote addr 永远不是回环，等于强制配置令牌。
 *
 * 豁免：/api/v1/health（部署巡检探活）、/mcp（自带 AI_DRAMA_MCP_TOKEN 校验，
 * 不双重 gating）、前端静态产物与 /static 媒体（uuid 命名不可枚举，且 <img>
 * 无法带 Authorization 头）。不信任 X-Forwarded-For（未配置可信反代时任意可伪造）。
 */
import { createHash, timingSafeEqual } from 'node:crypto'
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
  if (c.req.path === '/api/v1/health') return next()

  const expected = process.env.AI_DRAMA_API_TOKEN?.trim()
  if (expected) {
    const got = bearerToken(c)
    if (got && tokenMatches(got, expected)) return next()
    return c.json({ code: 401, message: 'Unauthorized: missing or invalid Authorization: Bearer token (AI_DRAMA_API_TOKEN)' }, 401)
  }

  const remote = remoteAddress(c)
  if (remote && LOOPBACK_ADDRESSES.has(remote)) return next()
  return c.json({
    code: 401,
    message: 'Unauthorized: server is reachable from a non-loopback address; configure AI_DRAMA_API_TOKEN and send it as Authorization: Bearer',
  }, 401)
}
