import type { MiddlewareHandler } from 'hono'

/**
 * Trusted identity written ONLY by the auth middleware chain after a token and
 * the backing server-side session have been verified. Handlers and services
 * must read identity from here — never from the request body, query string, or
 * client-supplied headers.
 */
export interface AuthContext {
  userId: string
  sessionId: string
  deviceId: string
}

export type AppBindings = {
  Variables: {
    requestId: string
    realIp: string
    /** Undefined until the full auth chain (JWT + DB session) has passed. */
    auth: AuthContext | undefined
  }
}

export type AppEnv = AppBindings

export function requireAuthContext(context: { get(key: 'auth'): AuthContext | undefined }): AuthContext {
  const auth = context.get('auth')
  if (!auth) {
    throw new Error('auth context missing: requireAuth/requireSession must run before handlers')
  }
  return auth
}

/** Typed helper so middleware can declare they populate `auth`. */
export type AuthMiddleware = MiddlewareHandler<AppEnv>
