import type { MiddlewareHandler } from 'hono'
import type { AppEnv, AuthContext } from '../shared/context.js'
import { HttpApiError } from '../shared/http.js'
import type { Auth } from '../modules/auth/auth.js'

/**
 * Authentication is Better Auth's session check (doc §5): the identity comes
 * from the library's server-side result — never from a self-signed JWT or a
 * client claim. `disableCookieCache` forces the authoritative store lookup on
 * every request so a revoked or expired session cannot ride on a cached
 * cookie. A database failure is 503, never an implicit allow.
 *
 * When an earlier middleware has already settled the identity with an equally
 * verified credential (a `bat_` user API token — see authenticateUserToken),
 * the session check steps aside instead of rejecting the cookie-less request.
 * Only auth-writing middleware registered before this one can set the context;
 * handlers still read identity exclusively from `c.get('auth')`.
 */
export function authenticate(auth: Auth): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get('auth') !== undefined) {
      await next()
      return
    }
    let result: { session: { id: string; userId: string }; user: { id: string } } | null
    try {
      result = (await auth.api.getSession({
        headers: c.req.raw.headers,
        query: { disableCookieCache: true },
      })) as { session: { id: string; userId: string }; user: { id: string } } | null
    } catch {
      throw new HttpApiError(503, 'dependency_unavailable', 'Service temporarily unavailable.')
    }
    if (result === null) {
      throw new HttpApiError(401, 'unauthorized', 'Authentication required.')
    }
    const identity: AuthContext = {
      userId: result.user.id,
      sessionId: result.session.id,
    }
    c.set('auth', identity)
    await next()
  }
}
