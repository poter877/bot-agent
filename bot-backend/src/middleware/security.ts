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
    // 管理台的 HTML 面（/admin 服务端渲染控制台 + /console SPA）与视频工厂的
    // SPA 兜底壳（drama 子应用对 Accept: text/html 的导航请求回 index.html）
    // 必须加载同源脚本/样式才能工作。注册在最前、于 next() 之后再改写 CSP，
    // 保证覆盖 secureHeaders 的 default-src 'none'（/api 与其余响应维持最严格）。
    function consoleCsp(c, next) {
      const htmlNavigation = (c.req.header('accept') ?? '').includes('text/html')
      const relaxed =
        c.req.path.startsWith('/admin') ||
        c.req.path.startsWith('/console') ||
        // 仅浏览器导航（HTML 文档）；API 客户端都声明 application/json，
        // 不会误入宽松档。
        htmlNavigation
      return next().then(() => {
        if (relaxed) {
          c.res.headers.set(
            'Content-Security-Policy',
            "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'",
          )
        }
      })
    } satisfies MiddlewareHandler<AppEnv>,
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
