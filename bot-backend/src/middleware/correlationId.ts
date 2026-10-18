import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../shared/context.js'

/**
 * Caller-supplied trace id (X-Correlation-Id): ai-drama stamps its film-task /
 * run id on hermes-gateway turns, hermes forwards it on model calls, and the
 * console's 失败请求 page joins the three layers by it. The value is recorded
 * verbatim (never parsed) after shape validation — anything outside
 * `[A-Za-z0-9._:-]` or over 128 chars is dropped, not logged. It is an echo
 * for correlation only: authorization stays on the verified session.
 */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

export function correlationIdMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const raw = c.req.header('x-correlation-id')?.trim()
    if (raw !== undefined && CORRELATION_ID_PATTERN.test(raw)) c.set('correlationId', raw)
    await next()
  }
}
