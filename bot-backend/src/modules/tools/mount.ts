import type { Hono } from 'hono'
import type { Config } from '../../config/env.js'
import type { RedisConnections } from '../../redis/client.js'
import type { AppEnv } from '../../shared/context.js'
import { serviceAuth } from '../../shared/context.js'
import type { Logger } from '../../shared/logger.js'
import type { Auth } from '../auth/auth.js'
import { authenticate } from '../../middleware/auth.js'
import { bodyPolicyMiddleware } from '../../middleware/bodyPolicy.js'
import { byAuthUserId, rateLimitMiddleware } from '../../middleware/rateLimit.js'
import { processingTimeout } from '../../middleware/timeout.js'
import { TOOLS_REQUEST_BUDGET_MS, createToolsRoutes } from './search.routes.js'

/**
 * Mount the managed tool gateway under /api/tools. The admission ladder
 * mirrors the media tree: own processing budget (register BEFORE the global
 * mount in app.ts — the media comment there explains the ordering), JSON body
 * policy, entry-ip flood guard, then a Better Auth session OR the internal
 * service token (attributed to MEDIA_SERVICE_USER_ID, same principal story as
 * /api/media and /api/llm), the tools-scope per-user budget, and the routes.
 */
export function mountToolsGateway(
  app: Hono<AppEnv>,
  deps: { config: Config; auth: Auth; redis: RedisConnections; logger: Logger },
): void {
  const { config, auth, redis, logger } = deps
  app.use('/api/tools/*', processingTimeout(TOOLS_REQUEST_BUDGET_MS))
  app.use('/api/tools/*', bodyPolicyMiddleware(config.API_BODY_LIMIT_BYTES))
  app.use(
    '/api/tools/*',
    rateLimitMiddleware({
      redis: redis.commands,
      scope: 'entry-ip',
      limit: config.RATE_LIMIT_ENTRY_MAX,
      windowSeconds: config.RATE_LIMIT_ENTRY_WINDOW_SECONDS,
      subject: (c) => c.get('realIp'),
    }),
  )
  app.use('/api/tools/*', async (c, next) => {
    const token = config.INTERNAL_SERVICE_TOKEN ?? config.MEDIA_SERVICE_TOKEN
    const authz = c.req.header('authorization')
    if (token && authz === `Bearer ${token}`) {
      c.set('auth', serviceAuth(config.MEDIA_SERVICE_USER_ID, 'tools'))
      await next()
      return
    }
    await authenticate(auth)(c, next)
  })
  app.use(
    '/api/tools/*',
    rateLimitMiddleware({
      redis: redis.commands,
      scope: 'tools',
      limit: config.RATE_LIMIT_TOOLS_MAX,
      windowSeconds: config.RATE_LIMIT_TOOLS_WINDOW_SECONDS,
      subject: byAuthUserId,
    }),
  )
  app.route('/api/tools', createToolsRoutes({ config, redis: redis.commands, logger }))
}
