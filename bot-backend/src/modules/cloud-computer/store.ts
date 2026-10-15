import { and, eq, gt, sql } from 'drizzle-orm'
import type { Db, Tx } from '../../db/client.js'
import { cloudComputer, session, type CloudComputerRow } from '../../db/schema.js'
import { HttpApiError } from '../../shared/http.js'

export async function withComputerLock<T>(db: Db, userId: string, run: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    // Transaction locks survive exceptions and serialize across API replicas.
    const result = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${'cloud-computer:' + userId}, 0)) AS locked`)
    if (result.rows[0]?.locked !== true) {
      throw new HttpApiError(409, 'conflict', 'The cloud computer is busy. Refresh its status and retry.')
    }
    return run(tx)
  })
}

export async function getComputer(db: Db | Tx, userId: string): Promise<CloudComputerRow | undefined> {
  return (await db.select().from(cloudComputer).where(eq(cloudComputer.userId, userId)).limit(1))[0]
}

export async function updateComputer(tx: Tx, row: CloudComputerRow, patch: Partial<CloudComputerRow>): Promise<CloudComputerRow> {
  const updated = (await tx.update(cloudComputer).set({ ...patch, updatedAt: new Date() }).where(eq(cloudComputer.id, row.id)).returning())[0]
  if (!updated) throw new HttpApiError(404, 'not_found', 'The cloud computer no longer exists.')
  return updated
}

export function clearedLease(row: CloudComputerRow) {
  return { leaseEpoch: row.leaseEpoch + 1, leaseTokenHash: null, leaseSessionId: null, leaseExpiresAt: null }
}

export async function expireLease(tx: Tx, row: CloudComputerRow): Promise<CloudComputerRow> {
  if (!row.leaseExpiresAt) return row
  const live = row.leaseSessionId && row.leaseExpiresAt.getTime() > Date.now()
    ? (await tx.select({ id: session.id }).from(session)
      .where(and(eq(session.id, row.leaseSessionId), eq(session.userId, row.userId), gt(session.expiresAt, new Date()))).limit(1))[0]
    : undefined
  return live ? row : updateComputer(tx, row, clearedLease(row))
}
