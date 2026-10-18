import { eq } from 'drizzle-orm'
import type { MiddlewareHandler } from 'hono'
import type { Db } from '../db/client.js'
import { apiTokens } from '../db/schema.js'
import type { AppEnv } from '../shared/context.js'
import { HttpApiError } from '../shared/http.js'
import { API_TOKEN_PREFIX, findActiveApiToken } from '../modules/account/tokens.js'

/** Only refresh last_used_at when the stored value is older than this. */
const LAST_USED_THROTTLE_MS = 60_000

/**
 * Bearer authentication for user API tokens (`Authorization: Bearer bat_…`).
 * Mounted BEFORE the session check on the API trees: a presented bat_ token is
 * validated against the stored hash and settles the identity with the
 * `api-token` session marker; any other Authorization value (the internal
 * service token) or none at all passes through untouched, so the existing
 * service-principal and Better Auth session flows are unaffected. An invalid
 * or revoked bat_ token is a hard 401 — an explicitly presented credential
 * never falls back to cookies.
 */
export function authenticateUserToken(db: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization')
    if (header === undefined || !header.startsWith(`Bearer ${API_TOKEN_PREFIX}`)) {
      await next()
      return
    }
    const secret = header.slice('Bearer '.length).trim()
    if (secret.length <= API_TOKEN_PREFIX.length) {
      throw new HttpApiError(401, 'unauthorized', 'Invalid API token.')
    }
    let token: Awaited<ReturnType<typeof findActiveApiToken>>
    try {
      token = await findActiveApiToken(db, secret)
    } catch {
      throw new HttpApiError(503, 'dependency_unavailable', 'Service temporarily unavailable.')
    }
    if (token === null) {
      throw new HttpApiError(401, 'unauthorized', 'Invalid API token.')
    }
    c.set('auth', { userId: token.userId, sessionId: 'api-token' })
    // Best-effort usage stamp, throttled so hot paths do not write per request.
    if (token.lastUsedAt === null || Date.now() - token.lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS) {
      try {
        await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, token.id))
      } catch {
        // A failed bookkeeping write must not fail an authenticated request.
      }
    }
    await next()
  }
}
