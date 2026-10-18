import type { Hono } from 'hono'
import type { Config } from '../../config/env.js'
import type { RedisConnections } from '../../redis/client.js'
import type { AppEnv } from '../../shared/context.js'
import type { Logger } from '../../shared/logger.js'
import { bodyPolicyMiddleware } from '../../middleware/bodyPolicy.js'
import { byAuthUserId, rateLimitMiddleware } from '../../middleware/rateLimit.js'
import { scopedProcessingTimeout } from '../../middleware/timeout.js'
import { TOOLS_SEARCH_VENDOR_TIMEOUT_MS, createToolsRoutes } from './search.routes.js'
import { TOOLS_EXTRACT_VENDOR_TIMEOUT_MS, createExtractRoutes } from './extract.routes.js'

/** Processing budget the mount registers for the /api/tools tree: the slowest
 * capability's vendor cap (extract: 20s — page rendering outlives a search
 * round-trip) + margin, so the scoped timer never races the vendor abort. */
const TOOLS_REQUEST_BUDGET_MS = Math.max(TOOLS_SEARCH_VENDOR_TIMEOUT_MS, TOOLS_EXTRACT_VENDOR_TIMEOUT_MS) + 5_000

/**
 * Mount the managed tool gateway under /api/tools. The admission ladder
 * mirrors the media tree: own processing budget (scopedProcessingTimeout —
 * it settles the budget so the global mount in app.ts defers), JSON body
 * policy, entry-ip flood guard, then the tools-scope per-user budget and the
 * routes. Identity is settled by the principal middleware mounted once in
 * app.ts (service token / bat_ user token / Better Auth session — same
 * principal story as /api/media and /api/llm).
 */
export function mountToolsGateway(
  app: Hono<AppEnv>,
  deps: { config: Config; redis: RedisConnections; logger: Logger },
): void {
  const { config, redis, logger } = deps
  app.use('/api/tools/*', scopedProcessingTimeout(TOOLS_REQUEST_BUDGET_MS))
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
  app.route('/api/tools', createExtractRoutes({ config, redis: redis.commands, logger }))
}
