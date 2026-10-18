import { HTTPException } from 'hono/http-exception'
import { timeout } from 'hono/timeout'
import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../shared/context.js'
import { SECURITY_RESPONSE_HEADERS } from './securityHeaders.js'

/**
 * Processing budgets. The abort only ends the HTTP exchange; callers that
 * spawn slower work must propagate cancellation (the pg pool runs with a
 * matching statement_timeout). SSE/WS routes, when they arrive, must not
 * mount these middlewares.
 *
 * Hono's timeout() arms one racing timer per mount and nested mounts settle
 * at the SHORTER duration, so a global budget must never wrap a tree that
 * carries its own: the tree settles the `budgetSettled` marker via
 * scopedProcessingTimeout and the global mount defers to it. Assembly rule:
 * every scoped budget is registered before the global one.
 */

function budgetTimeout(durationMs: number): MiddlewareHandler<AppEnv> {
  return timeout(durationMs, (c) => {
    const response = new Response(
      JSON.stringify({
        error: { code: 'request_timeout', message: 'The request exceeded its processing budget.' },
        request_id: c.get('requestId') ?? 'unknown',
      }),
      { status: 503, headers: { 'content-type': 'application/json; charset=UTF-8', ...SECURITY_RESPONSE_HEADERS } },
    )
    return new HTTPException(503, { res: response })
  })
}

/** The service-wide budget for ordinary endpoints. Trees with their own
 * scoped budget are exempt: the marker says this request is already bounded. */
export function processingTimeout(durationMs: number): MiddlewareHandler<AppEnv> {
  const bounded = budgetTimeout(durationMs)
  return async (c, next) => {
    if (c.get('budgetSettled')) {
      await next()
      return
    }
    await bounded(c, next)
  }
}

/** Tree-scoped budget (media generation, the tool gateway): arms its own
 * timer and settles the marker so the global mount steps aside. */
export function scopedProcessingTimeout(durationMs: number): MiddlewareHandler<AppEnv> {
  const bounded = budgetTimeout(durationMs)
  return async (c, next) => {
    c.set('budgetSettled', true)
    await bounded(c, next)
  }
}
