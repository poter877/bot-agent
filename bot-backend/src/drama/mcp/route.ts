/**
 * MCP 路由 — /mcp，streamable HTTP transport（无状态模式）。
 *
 * 鉴权：Authorization: Bearer <AI_DRAMA_MCP_TOKEN>。这是 hermes agent ↔ ai-drama
 * 后端之间的令牌（与 bot-backend 无关）；env 未配置或令牌不符一律 403（fail-closed）。
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

app.all('/', async (c) => {
  if (!tokenMatches(c)) {
    return c.json({ error: 'Forbidden: AI_DRAMA_MCP_TOKEN missing in Authorization: Bearer header, or not configured on the server' }, 403)
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

export default app
