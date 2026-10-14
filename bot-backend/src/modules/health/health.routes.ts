import { Hono } from 'hono'
import type { RedisClientType } from 'redis'
import type { Database } from '../../db/client.js'
import { checkDatabase } from '../../db/client.js'
import type { AppEnv } from '../../shared/context.js'

/**
 * GET /healthz — liveness: this process is up. No dependency checks, no
 * user or secret information.
 * GET /readyz — readiness: authoritative dependencies answer; when any is
 * down the instance exits the load-balancer pool with 503.
 */
export function createHealthRoutes(database: Database, redis: RedisClientType): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.get('/healthz', (c) => c.json({ data: { status: 'ok' } }, 200))

  routes.get('/readyz', async (c) => {
    const checks = { database: 'ok', redis: 'ok' }
    let ready = true
    try {
      ready = (await checkDatabase(database)) && ready
    } catch {
      checks.database = 'unavailable'
      ready = false
    }
    try {
      const pong = await redis.ping()
      ready = String(pong) === 'PONG' && ready
    } catch {
      checks.redis = 'unavailable'
      ready = false
    }
    return c.json({ data: { status: ready ? 'ready' : 'unavailable', checks } }, ready ? 200 : 503)
  })

  return routes
}
