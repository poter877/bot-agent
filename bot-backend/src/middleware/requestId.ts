import { randomUUID } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../shared/context.js'

/**
 * Server-generated request identity. Incoming X-Request-Id values are ignored
 * on purpose: error, rate-limit and access-log correlation must be keyed by an
 * identifier this service minted, not one an external caller chose (the hono
 * built-in middleware reuses the inbound header, so we generate unconditionally
 * and keep the same `requestId` context variable / response header contract).
 */
export function serverRequestId(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = randomUUID()
    c.set('requestId', requestId)
    c.header('X-Request-Id', requestId)
    await next()
  }
}
