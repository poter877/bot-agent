import { HTTPException } from 'hono/http-exception'
import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../shared/context.js'
import { SECURITY_RESPONSE_HEADERS } from './securityHeaders.js'

/**
 * Processing budgets. The abort only ends the HTTP exchange; callers that
 * spawn slower work must propagate cancellation (the pg pool runs with a
 * matching statement_timeout). SSE/WS routes, when they arrive, must not
 * mount these middlewares.
 *
 * 自实现竞速而非 hono/timeout：输掉竞速的下游链路若稍后失败，hono 的实现
 * 会把它变成 unhandledRejection 直接打死进程（曾因 tool-plan 慢查询超时后
 * 的迟到 PipelineInputRequired 复现）。这里对迟到的拒绝记录后吞掉——HTTP
 * 交换已以 503 结束，进程不应陪葬。
 */

function budgetTimeout(durationMs: number): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => resolve('expired'), durationMs)
      timer.unref?.()
    })
    const work = next()
    // 参赛的派生 Promise 必须自带拒绝处理：race 会把下游错误原样传给本层
    // await（Hono 照常产出 4xx/5xx），但 work.then(onFulfilled) 的派生件
    // 若无人接住，会成为 unhandledRejection 打死进程（曾因 tool-plan 的
    // PipelineInputRequired 复现）。
    const settled = work.then(() => 'done' as const)
    settled.catch(() => {})
    const outcome = await Promise.race([settled, expired])
    clearTimeout(timer)
    if (outcome === 'done') return
    work.catch((error) => {
      // 客户端已收到 503；迟到失败只留痕，不再冒泡为未处理拒绝
      console.error('[timeout] late downstream failure after budget expiry', {
        request_id: c.get('requestId') ?? 'unknown',
        path: c.req.path,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    const response = new Response(
      JSON.stringify({
        error: { code: 'request_timeout', message: 'The request exceeded its processing budget.' },
        request_id: c.get('requestId') ?? 'unknown',
      }),
      { status: 503, headers: { 'content-type': 'application/json; charset=UTF-8', ...SECURITY_RESPONSE_HEADERS } },
    )
    throw new HTTPException(503, { res: response })
  }
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
