import { and, eq, isNull, sql } from 'drizzle-orm'
import type { DbExecutor, Tx } from '../../db/client.js'
import { loginSessions } from '../../db/schema.js'
import { generateOpaqueToken, hashToken } from '../auth/tokens.js'

/**
 * Device login sessions and refresh-token rotation. The refresh token is an
 * opaque random credential; only its hash is stored. Rotation happens inside
 * a single transaction with SELECT ... FOR UPDATE: exactly one concurrent
 * request can rotate a given token, and reuse of an already-rotated (or
 * revoked) token trips replay detection, which revokes the whole rotation
 * family (RFC 9700 §4.14).
 */

export interface IssuedSession {
  userId: string
  sessionId: string
  familyId: string
  refreshToken: string
  expiresAt: Date
}

export async function createSession(
  db: DbExecutor,
  input: {
    userId: string
    deviceId: string
    deviceLabel?: string | null
    ttlSeconds: number
    /** Set when rotating inside an existing family. */
    familyId?: string
  },
): Promise<IssuedSession> {
  const refreshToken = generateOpaqueToken()
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000)
  const rows = await db
    .insert(loginSessions)
    .values({
      userId: input.userId,
      deviceId: input.deviceId,
      deviceLabel: input.deviceLabel ?? null,
      familyId: input.familyId ?? sql`gen_random_uuid()`,
      refreshTokenHash: hashToken(refreshToken),
      expiresAt,
    })
    .returning({ id: loginSessions.id, familyId: loginSessions.familyId })
  const row = rows[0]!
  return { userId: input.userId, sessionId: row.id, familyId: row.familyId, refreshToken, expiresAt }
}

export type RotateResult =
  | { outcome: 'rotated'; issued: IssuedSession; deviceId: string }
  | { outcome: 'replay' }
  | { outcome: 'invalid' }

export async function rotateSession(
  db: DbExecutor,
  input: { rawRefreshToken: string; ttlSeconds: number },
): Promise<RotateResult> {
  const refreshTokenHash = hashToken(input.rawRefreshToken)
  return db.transaction(async (tx) => {
    const found = await tx
      .select({
        id: loginSessions.id,
        userId: loginSessions.userId,
        deviceId: loginSessions.deviceId,
        familyId: loginSessions.familyId,
        revokedAt: loginSessions.revokedAt,
        expiresAt: loginSessions.expiresAt,
      })
      .from(loginSessions)
      .where(eq(loginSessions.refreshTokenHash, refreshTokenHash))
      .for('update')
      .limit(1)
    const session = found[0]
    if (session === undefined) {
      return { outcome: 'invalid' }
    }
    if (session.revokedAt !== null) {
      // Reuse of an already-consumed or revoked token: treat the whole family
      // as compromised and kill every live descendant.
      await revokeFamilyInTx(tx, session.familyId, 'replay_detected')
      return { outcome: 'replay' }
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      await revokeSessionInTx(tx, session.id, 'expired')
      return { outcome: 'invalid' }
    }

    const issued = await createSession(tx, {
      userId: session.userId,
      deviceId: session.deviceId,
      ttlSeconds: input.ttlSeconds,
      familyId: session.familyId,
    })
    await tx
      .update(loginSessions)
      .set({
        revokedAt: new Date(),
        revokedReason: 'rotated',
        replacedBySessionId: issued.sessionId,
        lastUsedAt: new Date(),
      })
      .where(eq(loginSessions.id, session.id))
    return { outcome: 'rotated', issued, deviceId: session.deviceId }
  })
}

export async function revokeSession(db: DbExecutor, sessionId: string, reason: string): Promise<boolean> {
  return db.transaction(async (tx) => revokeSessionInTx(tx, sessionId, reason))
}

export async function revokeFamily(db: DbExecutor, familyId: string, reason: string): Promise<void> {
  await db.transaction(async (tx) => revokeFamilyInTx(tx, familyId, reason))
}

export async function revokeAllUserSessions(db: DbExecutor, userId: string, reason: string): Promise<number> {
  const revoked = await db
    .update(loginSessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(loginSessions.userId, userId), isNull(loginSessions.revokedAt)))
    .returning({ id: loginSessions.id })
  return revoked.length
}

async function revokeSessionInTx(tx: Tx, sessionId: string, reason: string): Promise<boolean> {
  const rows = await tx
    .update(loginSessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(loginSessions.id, sessionId), isNull(loginSessions.revokedAt)))
    .returning({ id: loginSessions.id })
  return rows.length > 0
}

async function revokeFamilyInTx(tx: Tx, familyId: string, reason: string): Promise<void> {
  await tx
    .update(loginSessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(loginSessions.familyId, familyId), isNull(loginSessions.revokedAt)))
}
