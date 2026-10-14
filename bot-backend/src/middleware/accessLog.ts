import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../shared/context.js'
import type { Logger } from '../shared/logger.js'

/**
 * JSON access log: request id, method, route template (not the raw URL), real
 * IP, status and duration. Never logs headers or bodies.
 */
export function accessLogMiddleware(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const startedAt = performance.now()
    try {
      await next()
    } finally {
      const durationMs = Math.round(performance.now() - startedAt)
      const level = c.res.status >= 500 ? 'error' : c.res.status >= 400 ? 'warn' : 'info'
      logger[level](
        {
          request_id: c.get('requestId'),
          method: c.req.method,
          route: c.req.routePath ?? c.req.path,
          path: c.req.path,
          status: c.res.status,
          duration_ms: durationMs,
          ip: c.get('realIp'),
        },
        'request',
      )
    }
  }
}
