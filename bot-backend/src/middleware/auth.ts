import type { MiddlewareHandler } from 'hono'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { loginSessions, users } from '../db/schema.js'
import type { AppEnv, AuthContext } from '../shared/context.js'
import { HttpApiError } from '../shared/http.js'
import { verifyAccessToken } from '../modules/auth/tokens.js'
import type { Config } from '../config/env.js'

/**
 * Authentication chain, in the doc's fixed order:
 *
 *  1. JWT check — Bearer token only: fixed algorithm, trusted secret,
 *     issuer/audience/expiry, required claims (sub/sid/did/exp).
 *  2. Server-side session & account state — PostgreSQL is authoritative: the
 *     session exists, is not revoked or expired, matches the token subject,
 *     and the account is active. Only then is the trusted identity written to
 *     the context.
 *
 * A database failure is 503, never an implicit allow; a valid signature or a
 * client-side cache never substitutes for stage 2.
 */

export interface ActiveSession extends AuthContext {
  userStatus: 'pending_verification' | 'active' | 'disabled'
}

export async function loadActiveSession(db: Db, sessionId: string): Promise<ActiveSession | null> {
  const rows = await db
    .select({
      sessionId: loginSessions.id,
      userId: loginSessions.userId,
      deviceId: loginSessions.deviceId,
      sessionExpiresAt: loginSessions.expiresAt,
      revokedAt: loginSessions.revokedAt,
      userStatus: users.status,
    })
    .from(loginSessions)
    .innerJoin(users, eq(users.id, loginSessions.userId))
    .where(eq(loginSessions.id, sessionId))
    .limit(1)

  const row = rows[0]
  if (row === undefined) return null
  if (row.revokedAt !== null) return null
  if (row.sessionExpiresAt.getTime() <= Date.now()) return null
  return {
    sessionId: row.sessionId,
    userId: row.userId,
    deviceId: row.deviceId,
    userStatus: row.userStatus,
  }
}

export function authenticate(config: Config, db: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authorization = c.req.header('authorization')
    if (authorization === undefined || !authorization.startsWith('Bearer ')) {
      throw new HttpApiError(401, 'unauthorized', 'Authentication required.')
    }
    const token = authorization.slice('Bearer '.length).trim()
    if (token === '') {
      throw new HttpApiError(401, 'unauthorized', 'Authentication required.')
    }
    const identity = await verifyAccessToken(token, config)

    let session: ActiveSession | null
    try {
      session = await loadActiveSession(db, identity.sessionId)
    } catch {
      throw new HttpApiError(503, 'dependency_unavailable', 'Service temporarily unavailable.')
    }
    if (session === null) {
      throw new HttpApiError(401, 'unauthorized', 'Session is no longer valid.')
    }
    if (session.userId !== identity.userId) {
      // A token whose `sub` does not own the `sid` session is invalid even
      // with a correct signature — this is the ownership boundary.
      throw new HttpApiError(401, 'unauthorized', 'Session is no longer valid.')
    }
    if (session.userStatus !== 'active') {
      throw new HttpApiError(
        403,
        session.userStatus === 'disabled' ? 'account_disabled' : 'account_not_verified',
        'Account is not permitted to access this resource.',
      )
    }

    c.set('auth', { userId: session.userId, sessionId: session.sessionId, deviceId: session.deviceId })
    await next()
  }
}
