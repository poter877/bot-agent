/**
 * Security headers shared by every response shape. Normal responses get them
 * from the secureHeaders middleware; error responses are built by
 * app.onError/notFound AFTER that middleware's post-`next()` code never runs,
 * so the error path attaches the same map explicitly. Keep both lists in sync
 * through this constant.
 */
export const SECURITY_RESPONSE_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-site',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Origin-Agent-Cluster': '?1',
  'Content-Security-Policy': "default-src 'none'",
  'X-DNS-Prefetch-Control': 'off',
  'X-Download-Options': 'noopen',
  'X-Permitted-Cross-Domain-Policies': 'none',
  // Account and token responses must never be cached by proxies or browsers.
  'Cache-Control': 'no-store',
}
