import { secureHeaders } from 'hono/secure-headers'
import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../shared/context.js'

/**
 * Security response headers on normal and error responses alike (the
 * middleware runs before onError renders), plus HSTS for the TLS entry and
 * no-store for the whole versioned API: account/token responses must not be
 * cached by proxies or browsers.
 */
export function securityMiddleware(): Array<MiddlewareHandler<AppEnv>> {
  return [
    secureHeaders({
      // HSTS is harmless over plain HTTP dev traffic and correct behind TLS.
      strictTransportSecurity: 'max-age=31536000; includeSubDomains',
      xContentTypeOptions: true,
      xFrameOptions: 'DENY',
      referrerPolicy: 'no-referrer',
      crossOriginResourcePolicy: 'same-site',
      crossOriginOpenerPolicy: 'same-origin',
      originAgentCluster: true,
      // API responses never embed remote content.
      contentSecurityPolicy: { defaultSrc: ["'none'"] },
      removePoweredBy: true,
    }),
    function noStore(c, next) {
      c.header('Cache-Control', 'no-store')
      return next()
    } satisfies MiddlewareHandler<AppEnv>,
  ]
}
