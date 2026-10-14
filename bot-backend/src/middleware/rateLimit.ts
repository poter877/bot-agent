import { createHash } from 'node:crypto'
import type { Context } from 'hono'
import type { MiddlewareHandler } from 'hono'
import type { RedisClientType } from 'redis'
import type { AppEnv } from '../shared/context.js'
import { HttpApiError } from '../shared/http.js'
import { consumeRateLimitBucket, rateLimitExceeded, RedisUnavailableError, redisUnavailable } from '../redis/rateLimit.js'

export interface BucketOptions {
  redis: RedisClientType
  /** Bucket family, e.g. "entry", "login-account". */
  scope: string
  limit: number
  windowSeconds: number
  /** Returns the per-subject key part, or null to skip limiting. */
  subject: (c: Context<AppEnv>) => string | null | Promise<string | null>
}

/**
 * Consume one unit from a distributed bucket; throw 429 (with Retry-After) or
 * map a Redis outage to 503. Buckets are shared by every instance.
 */
export function rateLimitMiddleware(options: BucketOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const subject = await options.subject(c)
    if (subject !== null) {
      try {
        const result = await consumeRateLimitBucket(
          options.redis,
          `rl:${options.scope}:${subject}`,
          options.limit,
          options.windowSeconds,
        )
        if (!result.allowed) {
          throw rateLimitExceeded(result.retryAfterSeconds)
        }
      } catch (error) {
        if (error instanceof HttpApiError) throw error
        if (error instanceof RedisUnavailableError) throw redisUnavailable()
        throw error
      }
    }
    await next()
  }
}

export const byRealIp = (c: Context<AppEnv>): string => c.get('realIp')

/**
 * Normalized account subject from the request body. Uses Hono's cached JSON
 * parse (the stream is read once even though validation parses later);
 * unparseable bodies fall through to the 400 path without consuming a bucket.
 */
export function byBodyEmail(): (c: Context<AppEnv>) => Promise<string | null> {
  return async (c) => {
    const body = await c.req.json().catch(() => null) as unknown
    if (body === null || typeof body !== 'object') return null
    const email = (body as Record<string, unknown>)['email']
    return typeof email === 'string' && email.trim() !== ''
      ? `sha256:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`
      : null
  }
}

/** Per-user subject for authenticated traffic. */
export const byAuthUserId = (c: Context<AppEnv>): string | null => c.get('auth')?.userId ?? null
