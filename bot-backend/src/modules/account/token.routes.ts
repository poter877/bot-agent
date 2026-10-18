import { Hono } from 'hono'
import type { Db } from '../../db/client.js'
import type { AppEnv } from '../../shared/context.js'
import { requireAuthContext } from '../../shared/context.js'
import { HttpApiError } from '../../shared/http.js'
import { createApiToken, listApiTokens, publicToken, revokeApiToken } from './tokens.js'

/**
 * 用户 API 令牌自服务 CRUD（/api/account/tokens，会话登录者）。
 * 挂载约定（modules/account/mount.ts）：authenticate + user 限流在前。
 * 明文只在 POST 的响应里出现一次；列表与撤销永不回显。
 */

const NAME_MAX_LENGTH = 64

export function createTokenRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.get('/', async (c) => {
    const auth = requireAuthContext(c)
    const rows = await listApiTokens(db, auth.userId)
    return c.json({ data: { tokens: rows.map(publicToken) } }, 200)
  })

  routes.post('/', async (c) => {
    const auth = requireAuthContext(c)
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (name === '') {
      throw new HttpApiError(400, 'invalid_request', 'Field "name" is required.')
    }
    if (name.length > NAME_MAX_LENGTH) {
      throw new HttpApiError(400, 'invalid_request', `Name must be at most ${NAME_MAX_LENGTH} characters.`)
    }
    const created = await createApiToken(db, auth.userId, name)
    return c.json({ data: { token: publicToken(created.token), plaintext: created.plaintext } }, 201)
  })

  routes.post('/:id/revoke', async (c) => {
    const auth = requireAuthContext(c)
    const revoked = await revokeApiToken(db, auth.userId, c.req.param('id'))
    return c.json({ data: { token: publicToken(revoked) } }, 200)
  })

  return routes
}
