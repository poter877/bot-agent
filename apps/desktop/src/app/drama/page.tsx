import '@drama/app/styles/index.css'

import { DramaApp } from '@drama/embed'
/**
 * The studio page — the ai-drama frontend mounted NATIVELY in the renderer,
 * not in a webview: the same React tree the standalone SPA runs, on a memory
 * router so the app's URL stays on /drama. The app speaks same-origin
 * relative paths (/api/v1, /api/auth, /static); the dev server proxies those
 * prefixes to bot-backend, so its Better Auth cookie lands on the renderer
 * origin. Its own login route handles auth (probeSession guard).
 *
 * The studio renders in its OWN React root: the desktop page sits inside the
 * app's <Routes>, and react-router refuses a <RouterProvider> nested in
 * another router's subtree. A second root shares the single react/react-dom
 * copy while keeping both router (and provider) contexts apart.
 *
 * Packaged-app note: the proxy exists only under `vite dev` — the production
 * transport lane for the embedded studio is the gateway (see
 * ai-drama/docs/hermes-integration.md § 桌面 app 入口).
 */
import { type CSSProperties, useEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { createDesktopStudioHost } from './host'

export function DramaPage() {
  // A stable host: the ref holds the div, the effect owns the root lifecycle.
  // StrictMode's mount→unmount→mount just walks the same steps twice.
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    let root: Root | null = null

    // 宿主工厂需要 serve 的连接信息（baseUrl + 会话令牌）做上传与媒体
    // 通道——先取连接再挂载，host 成为纯同步对象。
    void window.hermesDesktop.getConnection().then(conn => {
      if (cancelled) {
        return
      }

      const host = hostRef.current

      if (!host) {
        return
      }

      root = createRoot(host)
      root.render(
        <DramaApp host={createDesktopStudioHost({ baseUrl: conn.baseUrl, token: conn.token ?? '' })} initialPath="/" />
      )
    })

    return () => {
      cancelled = true
      root?.unmount()
    }
  }, [])

  return (
    // --color-input is the ONE token both design systems define; re-pin the
    // drama value here so the page's utilities read their own palette no
    // matter which stylesheet's :root declaration won the load order.
    <div
      className="h-full min-h-0"
      ref={hostRef}
      style={{ '--color-input': 'var(--hb-surface-input)' } as CSSProperties}
    />
  )
}
