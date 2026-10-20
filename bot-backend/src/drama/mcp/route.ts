/**
 * MCP 路由 — /mcp，streamable HTTP transport（无状态模式）。
 *
 * 鉴权（两条，任一通过）：
 * 1. 用户会话：与宿主同一 Better Auth 会话（cookie）——《重构》方案 §7 的
 *    MCP 账号桥：桌面 serve 内的插件按当前 profile 取用户凭据转发，工具
 *    归属真实用户，云端不信任工具参数里自报的 user_id。
 * 2. 静态共享令牌：Authorization: Bearer <AI_DRAMA_MCP_TOKEN>——hermes
 *    gateway ↔ ai-drama 的部署级令牌，仅作迁移期兼容（P4 撤除旧链路后收回）。
 *
 * 两条都不满足一律 403（fail-closed）。env 未配置静态令牌时仅用户会话可用。
 *
 * 会话/状态：无状态 —— 每个 POST 新建 transport + server，响应即结束
 * （enableJsonResponse，无 SSE 长连接），客户端每次调用带齐参数。
 * GET（服务端推送流）与 DELETE（会话终止）在本模式下按规范返回 405。
 */
import { Hono } from 'hono'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Context } from 'hono'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { logTaskProgress } from '../utils/task-logger.js'
import { buildMcpServer } from './server.js'
import type { Auth } from '../../modules/auth/auth.js'

const app = new Hono()

/** X-Correlation-Id 契约（与 gateway / bot-backend 一致）：≤128 字符且仅
 *  [A-Za-z0-9._:-]，不合规则忽略不记录。 */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

function bearerToken(c: Context): string | null {
  const header = c.req.header('authorization')
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token || null
}

/** 常量时间比较（先哈希抹平长度差，避免 timingSafeEqual 的长度前置泄露） */
function tokenMatches(c: Context): boolean {
  const expected = process.env.AI_DRAMA_MCP_TOKEN
  if (!expected) return false
  const got = bearerToken(c)
  if (!got) return false
  const a = createHash('sha256').update(expected).digest()
  const b = createHash('sha256').update(got).digest()
  return timingSafeEqual(a, b)
}

/** 用户会话校验：Better Auth cookie（与 /api/v1 同一身份源） */
function userSessionValid(auth: Auth | null): (c: Context) => Promise<boolean> {
  return async c => {
  if (!auth) return false
  try {
    const session = (await auth.api.getSession({ headers: c.req.raw.headers })) as unknown as { user?: { id?: string } } | null
    return Boolean(session?.user?.id)
  } catch {
    return false
  }
  }
}

export function createMcpApp(auth: Auth | null): Hono {
const app = new Hono()

app.all('/', async (c) => {
  const sessionValid = userSessionValid(auth)
  if (!tokenMatches(c) && !(await sessionValid(c))) {
    return c.json({ error: 'Forbidden: a user session cookie or the migration-period AI_DRAMA_MCP_TOKEN bearer is required' }, 403)
  }
  if (c.req.method !== 'POST') {
    return c.json({ error: 'Method Not Allowed: stateless MCP endpoint, POST JSON-RPC only' }, 405)
  }
  // 带关联头的工具执行请求落一行日志：把 hermes turn（及其上游影片任务）
  // 与本侧工具执行对上，排查失败不再对时间戳。
  const correlationId = c.req.header('x-correlation-id')?.trim()
  if (correlationId && CORRELATION_ID_PATTERN.test(correlationId)) {
    logTaskProgress('Mcp', 'request', { correlationId })
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // 无状态：不分配会话
    enableJsonResponse: true,      // 请求/响应式 JSON，不开 SSE 流
  })
  const server = buildMcpServer()
  try {
    await server.connect(transport)
    return await transport.handleRequest(c.req.raw)
  } finally {
    await server.close()
  }
})


return app
}
