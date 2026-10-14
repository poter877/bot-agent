import type { RedisClientType } from 'redis'
import { HttpApiError } from '../shared/http.js'

/**
 * Fixed-window counter shared by every API instance through Redis. Rules are
 * distributed by design — a per-process counter can never enforce them. When
 * Redis is unavailable the limiter fails CLOSED (503): protection interfaces
 * must not degrade into unlimited traffic.
 */

const CONSUME_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

export class RedisUnavailableError extends Error {
  constructor(cause: unknown) {
    super('rate limit backend unavailable')
    this.name = 'RedisUnavailableError'
    this.cause = cause
  }
}

export async function consumeRateLimitBucket(
  redis: RedisClientType,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  let result: unknown
  try {
    result = await redis.eval(CONSUME_SCRIPT, { keys: [key], arguments: [String(windowSeconds * 1000)] })
  } catch (error) {
    throw new RedisUnavailableError(error)
  }
  const pair = result as [number, number]
  const count = Number(pair[0])
  const windowTtlMs = Number(pair[1])
  const retryAfterSeconds = Math.max(1, Math.ceil((windowTtlMs > 0 ? windowTtlMs : windowSeconds * 1000) / 1000))
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds,
  }
}

export function rateLimitExceeded(retryAfterSeconds: number): HttpApiError {
  return new HttpApiError(429, 'rate_limited', 'Too many requests, slow down.', {
    'Retry-After': String(retryAfterSeconds),
  })
}

export function redisUnavailable(): HttpApiError {
  return new HttpApiError(503, 'dependency_unavailable', 'Service temporarily unavailable.')
}
