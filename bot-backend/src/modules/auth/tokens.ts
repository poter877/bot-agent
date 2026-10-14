import { createHash, randomBytes } from 'node:crypto'
import { sign, verify } from 'hono/jwt'
import { HttpApiError } from '../../shared/http.js'
import type { AuthContext } from '../../shared/context.js'
import type { Config } from '../../config/env.js'

/**
 * Access tokens are short-lived HS256 JWTs bound to a server-side login
 * session. `sid` (session id) is a required claim: without it the session
 * check could not anchor the token to database state. Verification enforces a
 * fixed algorithm, expected issuer/audience, and REQUIRED claims — a token
 * missing any of them is rejected even if the signature verifies, because the
 * JWT spec only checks `exp` when the claim happens to be present.
 */

export interface AccessTokenClaims extends AuthContext {
  exp: number
  iat: number
  iss: string
  aud: string
}

export async function signAccessToken(
  identity: AuthContext,
  config: Config,
): Promise<{ token: string; expiresInSeconds: number }> {
  const issuedAt = Math.floor(Date.now() / 1000)
  const token = await sign(
    {
      sub: identity.userId,
      sid: identity.sessionId,
      did: identity.deviceId,
      iss: config.JWT_ISSUER,
      aud: config.JWT_AUDIENCE,
      iat: issuedAt,
      exp: issuedAt + config.ACCESS_TOKEN_TTL_SECONDS,
    },
    config.AUTH_JWT_SECRET,
    'HS256',
  )
  return { token, expiresInSeconds: config.ACCESS_TOKEN_TTL_SECONDS }
}

export async function verifyAccessToken(token: string, config: Config): Promise<AuthContext> {
  let payload: Record<string, unknown>
  try {
    payload = (await verify(token, config.AUTH_JWT_SECRET, {
      alg: 'HS256',
      iss: config.JWT_ISSUER,
      aud: config.JWT_AUDIENCE,
    })) as Record<string, unknown>
  } catch {
    throw new HttpApiError(401, 'unauthorized', 'Access token is invalid or expired.')
  }
  if (
    typeof payload.exp !== 'number' ||
    typeof payload.sub !== 'string' ||
    typeof payload.sid !== 'string' ||
    typeof payload.did !== 'string'
  ) {
    throw new HttpApiError(401, 'unauthorized', 'Access token is invalid or expired.')
  }
  return { userId: payload.sub, sessionId: payload.sid, deviceId: payload.did }
}

/** High-entropy opaque credential for refresh / verify / reset flows. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Only hashes are stored server-side; lookup and reuse checks run on hashes. */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}
