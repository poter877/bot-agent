import { HTTPException } from 'hono/http-exception'
import { timeout } from 'hono/timeout'
import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../shared/context.js'
import { SECURITY_RESPONSE_HEADERS } from './securityHeaders.js'

/**
 * Processing budget for ordinary account endpoints. The abort only ends the
 * HTTP exchange; callers that spawn slower work must propagate cancellation
 * (the pg pool runs with a matching statement_timeout). SSE/WS routes, when
 * they arrive, must not mount this middleware.
 */
export function processingTimeout(durationMs: number): MiddlewareHandler<AppEnv> {
  return timeout(durationMs, () => {
    const response = new Response(
      JSON.stringify({
        error: { code: 'request_timeout', message: 'The request exceeded its processing budget.' },
      }),
      { status: 503, headers: { 'content-type': 'application/json; charset=UTF-8', ...SECURITY_RESPONSE_HEADERS } },
    )
    return new HTTPException(503, { res: response })
  })
}
