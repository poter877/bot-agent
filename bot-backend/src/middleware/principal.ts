import { eq } from 'drizzle-orm'
import type { Context, MiddlewareHandler } from 'hono'
import type { Config } from '../config/env.js'
import type { Db } from '../db/client.js'
import { apiTokens } from '../db/schema.js'
import type { AppEnv } from '../shared/context.js'
import { serviceAuth } from '../shared/context.js'
import { HttpApiError } from '../shared/http.js'
import { API_TOKEN_PREFIX, findActiveApiToken } from '../modules/account/tokens.js'
import { settleSessionIdentity } from './auth.js'
import type { Auth } from '../modules/auth/auth.js'

/**
 * One identity ladder for the API trees (/api/llm, /api/media, /api/tools),
 * replacing the three per-tree inline blocks (service token + session) and
 * mountAccount's ordering-dependent `bat_` mounts. In order:
 *
 *   1. internal service token (`Authorization: Bearer <INTERNAL_SERVICE_TOKEN
 *      ?? MEDIA_SERVICE_TOKEN>`) → service principal `service:<area>`,
 *      attributed to MEDIA_SERVICE_USER_ID (same directory, quota and ledger);
 *   2. user API token (`Bearer bat_…`) → validated against the stored hash;
 *      an explicitly presented invalid/revoked token is a hard 401 — it never
 *      falls back to cookies;
 *   3. Better Auth session (authoritative store lookup).
 *
 * The middleware only SETTLES identity; every tree's handlers read it via
 * requireAuthContext. Trees outside the three prefixes pass through
 * untouched, so public routes (/api/auth/*, portal, admin) keep their own
 * admission story. Same-origin exemptions for non-browser principals are
 * decided by the routes (isNonBrowserPrincipal), not here.
 */

/** Only refresh last_used_at when the stored value is older than this. */
const LAST_USED_THROTTLE_MS = 60_000

const PRINCIPAL_AREAS = ['llm', 'media', 'tools'] as const

type PrincipalArea = (typeof PRINCIPAL_AREAS)[number]

/** '/api/media/image' → 'media'; '/api/media' (exact) and '/api/mediaX' → none. */
function principalAreaOf(path: string): PrincipalArea | undefined {
  const segment = path.split('/')[2]
  return PRINCIPAL_AREAS.find((area) => segment === area)
}

export interface PrincipalDeps {
  config: Config
  db: Db
  auth: Auth
}

async function settleApiToken(c: Context<AppEnv>, db: Db, secret: string): Promise<void> {
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
}

export function principalMiddleware(deps: PrincipalDeps): MiddlewareHandler<AppEnv> {
  const { config, db, auth } = deps
  return async (c, next) => {
    const area = principalAreaOf(c.req.path)
    if (area === undefined) {
      await next()
      return
    }
    const authz = c.req.header('authorization')
    const serviceToken = config.INTERNAL_SERVICE_TOKEN ?? config.MEDIA_SERVICE_TOKEN
    if (serviceToken !== undefined && authz === `Bearer ${serviceToken}`) {
      c.set('auth', serviceAuth(config.MEDIA_SERVICE_USER_ID, area))
      await next()
      return
    }
    if (authz !== undefined && authz.startsWith(`Bearer ${API_TOKEN_PREFIX}`)) {
      await settleApiToken(c, db, authz.slice('Bearer '.length).trim())
      await next()
      return
    }
    await settleSessionIdentity(c, auth)
    await next()
  }
}
