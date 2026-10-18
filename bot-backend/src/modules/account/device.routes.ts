import { Hono } from 'hono'
import type { Db } from '../../db/client.js'
import type { AppEnv } from '../../shared/context.js'
import { HttpApiError } from '../../shared/http.js'
import {
  approveDeviceCode,
  createDeviceCode,
  exchangeDeviceCode,
} from './device.js'

/**
 * 设备码登录端点（/api/auth/device，匿名可达，除 approve 外）。
 *
 *   POST /code    匿名创建：返回 {code: XXXX-XXXX, verify_url, expires_in}
 *   POST /approve 会话登录者提交 code → 绑定 userId + approvedAt
 *                 （挂载时由 mountAccount 在该路径前加 authenticate）
 *   POST /token   匿名轮询：pending 400 / expired 400 / consumed 409 /
 *                 批准未消费 → 签发 api_token 并置 consumedAt
 *
 * 请求体均为空 JSON 对象（{}）；限流沿用 /api/auth/* 树的 entry-ip 桶。
 */

function codeFromBody(raw: unknown): string {
  const code = (raw as { code?: unknown } | null)?.code
  if (typeof code !== 'string' || code.trim() === '') {
    throw new HttpApiError(400, 'invalid_request', 'Field "code" is required.')
  }
  return code.trim()
}

export interface DeviceRoutesDeps {
  config: { BETTER_AUTH_URL: string }
  db: Db
}

export function createDeviceRoutes(deps: DeviceRoutesDeps): Hono<AppEnv> {
  const { db } = deps
  const origin = new URL(deps.config.BETTER_AUTH_URL).origin
  const routes = new Hono<AppEnv>()

  routes.post('/code', async (c) => {
    await c.req.json().catch(() => null)
    const created = await createDeviceCode(db, c.req.header('user-agent') ?? null)
    return c.json(
      {
        data: {
          code: created.code,
          verify_url: `${origin}/account/device?code=${encodeURIComponent(created.code)}`,
          expires_in: created.expiresInSeconds,
        },
      },
      200,
    )
  })

  // Identity comes from the authenticate middleware mounted ahead of this
  // route (see modules/account/mount.ts); the code being approved is the only
  // client-supplied input.
  routes.post('/approve', async (c) => {
    const auth = c.get('auth')
    if (!auth) throw new HttpApiError(401, 'unauthorized', 'Authentication required.')
    const body = await c.req.json().catch(() => null)
    const row = await approveDeviceCode(db, auth.userId, codeFromBody(body))
    return c.json({ data: { approved: true, code_id: row.id } }, 200)
  })

  routes.post('/token', async (c) => {
    const body = await c.req.json().catch(() => null)
    const issued = await exchangeDeviceCode(db, codeFromBody(body))
    return c.json({ data: { token: issued.plaintext, name: issued.name } }, 200)
  })

  return routes
}
