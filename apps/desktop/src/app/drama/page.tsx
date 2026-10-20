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
    const host = hostRef.current

    if (!host) {
      return
    }

    const root: Root = createRoot(host)
    root.render(<DramaApp host={createDesktopStudioHost()} initialPath="/" />)

    return () => {
      root.unmount()
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
