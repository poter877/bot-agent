import type { RedisClientType } from 'redis'
import { HttpApiError } from '../../shared/http.js'

/**
 * Concurrency and usage accounting for model streams (doc《流式服务端重构》§7).
 *
 * The concurrency slot is a Redis key with a safety TTL: a handler that dies
 * without releasing cannot pin the user's slot forever. Redis failing here is
 * fail-closed 503 — the model gateway must not degrade into unlimited traffic.
 * Usage is recorded from upstream-reported numbers only — a stream that ends
 * without usage is flagged unknown for reconciliation, never zero-filled.
 */

const CONCURRENCY_TTL_SECONDS = 30 * 60

export class ConcurrencyGuard {
  constructor(
    private readonly redis: RedisClientType,
    private readonly maxPerUser: number,
  ) {}

  /** `overrideLimit` is the console-set per-user cap; null = service default. */
  async acquire(userId: string, overrideLimit: number | null = null): Promise<void> {
    const key = `llm:conc:${userId}`
    let count: number
    try {
      count = await this.redis.incr(key)
      if (count === 1) {
        await this.redis.expire(key, CONCURRENCY_TTL_SECONDS)
      }
    } catch (error) {
      throw new HttpApiError(503, 'dependency_unavailable', 'Service temporarily unavailable.')
    }
    if (count > (overrideLimit ?? this.maxPerUser)) {
      try {
        await this.redis.decr(key)
      } catch {
        // The safety TTL reclaims the phantom slot.
      }
      throw new HttpApiError(429, 'concurrency_limit', 'Too many concurrent model requests for this account.')
    }
  }

  async release(userId: string): Promise<void> {
    try {
      await this.redis.decr(`llm:conc:${userId}`)
    } catch {
      // The safety TTL reclaims the slot; a failed release must not break the stream teardown.
    }
  }
}

export interface UpstreamUsage {
  inputTokens: number | undefined
  outputTokens: number | undefined
  totalTokens: number | undefined
  cacheReadTokens: number | undefined
  cacheWriteTokens: number | undefined
}

function usageDayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10).replaceAll('-', '')
}

export async function recordStreamUsage(
  redis: RedisClientType,
  userId: string,
  modelId: string,
  usage: UpstreamUsage | undefined,
): Promise<void> {
  const key = `llm:usage:${userId}:${usageDayKey()}`
  try {
    if (usage === undefined) {
      await redis.hIncrBy(key, 'unknown_usage', 1)
    } else {
      for (const [field, value] of Object.entries({
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        total_tokens: usage.totalTokens,
        cache_read_tokens: usage.cacheReadTokens,
        cache_write_tokens: usage.cacheWriteTokens,
      })) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          await redis.hIncrBy(key, field, value)
        } else {
          await redis.hIncrBy(key, `unknown_${field}`, 1)
        }
      }
    }
    await redis.hIncrBy(key, 'requests', 1)
    await redis.hIncrBy(key, `model:${modelId}`, 1)
    await redis.expire(key, 90 * 24 * 3600)
  } catch {
    // Usage bookkeeping is best-effort on the serve path; the structured
    // access log with usage is the reconciliation source when Redis hiccups.
  }
}
