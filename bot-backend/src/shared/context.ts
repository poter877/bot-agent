import type { MiddlewareHandler } from 'hono'

/**
 * Trusted identity written ONLY by the auth middleware after Better Auth has
 * verified the session server-side. Handlers and services must read identity
 * from here — never from the request body, query string, or client-supplied
 * headers. device_id joins when the message-phase device connection lands
 * (doc §5: 后续 device_id 由设备连接绑定).
 */
export interface AuthContext {
  userId: string
  sessionId: string
}

/**
 * Internal server-to-server principals (ai-drama 等) share the session slot
 * with a namespaced marker: no Better Auth session exists for them, and
 * browser-only admissions (same-origin checks) must not apply.
 */
export function serviceAuth(userId: string, area: string): AuthContext {
  return { userId, sessionId: `service:${area}` }
}

export function isServicePrincipal(auth: AuthContext): boolean {
  return auth.sessionId.startsWith('service:')
}

export type AppBindings = {
  Variables: {
    requestId: string
    realIp: string
    /** Sanitized X-Correlation-Id echo from an authenticated caller (ai-drama
     * task / hermes turn); undefined when the header was absent or invalid. */
    correlationId: string | undefined
    /** Undefined until the Better Auth session check has passed. */
    auth: AuthContext | undefined
  }
}

export type AppEnv = AppBindings

export function requireAuthContext(context: { get(key: 'auth'): AuthContext | undefined }): AuthContext {
  const auth = context.get('auth')
  if (!auth) {
    throw new Error('auth context missing: authenticate must run before handlers')
  }
  return auth
}

/** Typed helper so middleware can declare they populate `auth`. */
export type AuthMiddleware = MiddlewareHandler<AppEnv>
