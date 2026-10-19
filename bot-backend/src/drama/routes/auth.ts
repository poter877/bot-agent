/**
 * /api/v1/auth/* → 公司后端 /api/auth/* 透传代理（登录/注册/登出/会话查询）。
 *
 * 浏览器只与本服务同源交互（跨源 Cookie 在 http 本地环境下不可行），Cookie 由
 * 代理双向转发；Origin 改写为公司后端自身 origin —— better-auth 的 CSRF/origin
 * 校验按其 baseURL 进行，透传浏览器 origin 会被拒。白名单收窄到四个操作，
 * 不做通配转发。未配置公司后端时登录不可用（503），前端按旧模式运行。
 */
import { Hono } from 'hono'
import { companyBackendUrl } from '../services/company-backend.js'

const PROXY_TARGETS: Record<string, string> = {
  'sign-in/email': 'sign-in/email',
  'sign-up/email': 'sign-up/email',
  'sign-out': 'sign-out',
  session: 'get-session',
}

export const authProxy = new Hono().all('/:path{.+}', async (c) => {
  const target = companyBackendUrl()
  if (!target) return c.json({ code: 503, message: '未配置公司后端（COMPANY_BACKEND_URL），登录不可用' }, 503)
  const path = c.req.param('path')
  const upstreamPath = PROXY_TARGETS[path]
  if (!upstreamPath) return c.json({ code: 404, message: '不支持的认证操作' }, 404)

  let upstream: Response
  try {
    upstream = await fetch(`${target}/api/auth/${upstreamPath}`, {
      method: c.req.method,
      headers: {
        'content-type': 'application/json',
        cookie: c.req.header('cookie') ?? '',
        origin: target,
      },
      body: c.req.method === 'POST' ? await c.req.text() : undefined,
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    return c.json({ code: 502, message: '公司后端不可达，请稍后重试' }, 502)
  }

  const res = c.newResponse(upstream.body as ReadableStream<Uint8Array> | null, upstream.status as 200)
  for (const cookie of upstream.headers.getSetCookie()) res.headers.append('set-cookie', cookie)
  res.headers.set('content-type', upstream.headers.get('content-type') ?? 'application/json')
  res.headers.set('cache-control', 'no-store')
  return res
})
