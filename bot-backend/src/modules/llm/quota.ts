import type { RedisClientType } from 'redis'
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { userQuotas } from '../../db/schema.js'
import { HttpApiError } from '../../shared/http.js'

/**
 * Per-user quota enforcement (doc《流式服务端重构》§7: 按认证用户限制并发、
 * 模型访问及额度). The console writes `user_quotas`; the gateway enforces
 * them before any vendor call. Absent row = service defaults; null columns
 * mean "not overridden". Quota reads are per-request DB hits — they run once
 * per model request, not per token.
 */

export interface UserQuota {
  dailyTokenLimit: number | null
  concurrencyLimit: number | null
  modelAllowlist: string[] | null
}

export async function loadUserQuota(db: Db, userId: string): Promise<UserQuota | null> {
  const rows = await db.select().from(userQuotas).where(eq(userQuotas.userId, userId)).limit(1)
  const row = rows[0]
  if (row === undefined) return null
  let allowlist: string[] | null = null
  if (row.modelAllowlist) {
    try {
      const parsed: unknown = JSON.parse(row.modelAllowlist)
      allowlist = Array.isArray(parsed) ? parsed.map(String) : null
    } catch {
      allowlist = null
    }
  }
  return {
    dailyTokenLimit: row.dailyTokenLimit,
    concurrencyLimit: row.concurrencyLimit,
    modelAllowlist: allowlist,
  }
}

function usageDayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10).replaceAll('-', '')
}

/**
 * Allowlist + daily token budget checks. Concurrency is returned for the
 * caller's guard (per-request override of the service default). Unknown
 * upstream usage never counts toward the budget (missing numbers are flagged
 * for reconciliation, never guessed) — the request log is the audit trail.
 */
export async function enforceQuota(
  db: Db,
  redis: RedisClientType,
  userId: string,
  modelId: string,
): Promise<{ concurrencyLimit: number | null }> {
  const quota = await loadUserQuota(db, userId)
  if (quota === null) return { concurrencyLimit: null }

  if (quota.modelAllowlist !== null && !quota.modelAllowlist.some((id) => id.toLowerCase() === modelId.toLowerCase())) {
    throw new HttpApiError(403, 'model_not_allowed', `Model "${modelId}" is not enabled for this account.`)
  }

  if (quota.dailyTokenLimit !== null) {
    const usage = await redis.hGetAll(`llm:usage:${userId}:${usageDayKey()}`)
    const usedToday = Number(usage.total_tokens ?? 0)
    if (usedToday >= quota.dailyTokenLimit) {
      throw new HttpApiError(429, 'quota_exceeded', 'Daily token quota exhausted for this account.')
    }
  }

  return { concurrencyLimit: quota.concurrencyLimit }
}
