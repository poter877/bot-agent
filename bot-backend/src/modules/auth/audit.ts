import type { Db } from '../../db/client.js'
import { authAudit } from '../../db/schema.js'

export interface AuditEntry {
  userId?: string | null
  event: string
  requestId?: string
  ip?: string
  userAgent?: string | null
  details?: Record<string, unknown>
}

/**
 * Append-only authentication audit trail. Entries carry identifiers and
 * outcomes only — never passwords, raw tokens, or work content.
 */
export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(authAudit).values({
    userId: entry.userId ?? null,
    event: entry.event,
    requestId: entry.requestId ?? null,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
    details: entry.details,
  })
}
