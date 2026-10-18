import { randomUUID } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { llmRequestLog } from '../../db/schema.js'
import type { AuthContext } from '../../shared/context.js'
import type { UpstreamUsage } from './usage.js'

/**
 * Gateway request journal — the console's 失败请求 page reads this. One row
 * per attributed model-stream request: completed, failed mid-stream, or
 * rejected before headers (quota / permission / validation). Bookkeeping is
 * best-effort: a failed insert must never take the user's stream down.
 */

export interface RequestLogInput {
  requestId: string
  auth: AuthContext
  modelId: string
  status: 'complete' | 'failed' | 'rejected'
  /** Sanitized X-Correlation-Id from the request context; null when the caller sent none. */
  correlationId?: string | null
  errorCode?: string
  errorMessage?: string
  finishReason?: string
  usage?: UpstreamUsage
  durationMs: number
}

export async function recordRequestLog(db: Db, input: RequestLogInput): Promise<void> {
  try {
    await db.insert(llmRequestLog).values({
      id: randomUUID(),
      requestId: input.requestId,
      userId: input.auth.userId,
      sessionId: input.auth.sessionId,
      modelId: input.modelId,
      status: input.status,
      correlationId: input.correlationId ?? null,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage?.slice(0, 500) ?? null,
      finishReason: input.finishReason ?? null,
      inputTokens: input.usage?.inputTokens ?? null,
      outputTokens: input.usage?.outputTokens ?? null,
      totalTokens: input.usage?.totalTokens ?? null,
      durationMs: input.durationMs,
    })
  } catch {
    // The structured access log still carries the request; reconciliation
    // survives on it when this insert fails.
  }
}

export interface RequestLogQuery {
  status?: 'complete' | 'failed' | 'rejected'
  userId?: string
  limit?: number
}

export async function listRequestLog(db: Db, query: RequestLogQuery = {}) {
  const conditions = []
  if (query.status !== undefined) conditions.push(eq(llmRequestLog.status, query.status))
  if (query.userId !== undefined) conditions.push(eq(llmRequestLog.userId, query.userId))
  return db
    .select()
    .from(llmRequestLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(llmRequestLog.createdAt))
    .limit(Math.min(query.limit ?? 100, 500))
}
