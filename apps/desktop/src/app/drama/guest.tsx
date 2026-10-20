/**
 * The studio guest — bot-backend's drama SPA in an Electron `<webview>`, on the
 * same guest contract as the in-app Browser: the `persist:hermes-preview`
 * partition (main's will-attach-webview installs that partition's guest
 * preload and no-throttle prefs), sandbox on, node off, and NO popups — a
 * guest `target="_blank"` reaches the OS browser only through the audited
 * trusted-click bridge (preview-guest-preload → PREVIEW_EXTERNAL_CHANNEL →
 * hermes:openExternal). Sharing the partition with the Browser is the point:
 * one studio login serves every embedded surface.
 */
import { useEffect, useRef } from 'react'

import { openExternalLink } from '@/lib/external-link'
import { admitPreviewExternalUrl, PREVIEW_EXTERNAL_CHANNEL } from '@/lib/preview-external'

export interface DramaGuestState {
  error: null | { code?: number; description?: null | string; url?: null | string }
  loading: boolean
}

type GuestWebview = HTMLElement & { reload?: () => void }

export function DramaGuest({
  baseUrl,
  onState,
  reloadKey
}: {
  baseUrl: string
  onState: (state: DramaGuestState) => void
  reloadKey: number
}) {
  const hostRef = useRef<HTMLDivElement>(null)

  // Built once per origin: changing the service is a different site, so the
  // guest is rebuilt (new cookies, new document) rather than steered.
  useEffect(() => {
    const host = hostRef.current

    if (!host) {
      return
    }

    onState({ error: null, loading: true })

    const webview = document.createElement('webview') as GuestWebview
    webview.className = 'h-full w-full'
    webview.setAttribute('partition', 'persist:hermes-preview')
    webview.setAttribute('src', baseUrl)
    webview.setAttribute('webpreferences', 'contextIsolation=yes,nodeIntegration=no,sandbox=yes')
    host.replaceChildren(webview)

    const onGuestExternal = (event: Event) => {
      const detail = event as Event & { args?: unknown[]; channel?: string }

      if (detail.channel !== PREVIEW_EXTERNAL_CHANNEL) {
        return
      }

      const url = String(detail.args?.[0] ?? '')

      if (admitPreviewExternalUrl(url)) {
        openExternalLink(url)
      }
    }

    const onStart = () => onState({ error: null, loading: true })

    const onStop = () => onState({ error: null, loading: false })

    const onNavigate = () => onState({ error: null, loading: false })

    const onFail = (event: Event) => {
      const detail = event as Event & {
        errorCode?: number
        errorDescription?: string
        isMainFrame?: boolean
        validatedURL?: string
      }

      // Subframe failures (a blocked tracker iframe) must not cover an
      // otherwise healthy page; -3 is a cancelled load, not an error.
      if (detail.isMainFrame === false || detail.errorCode === -3) {
        return
      }

      onState({
        error: {
          code: detail.errorCode,
          description: detail.errorDescription || null,
          url: detail.validatedURL || baseUrl
        },
        loading: false
      })
    }

    webview.addEventListener('ipc-message', onGuestExternal)
    webview.addEventListener('did-start-loading', onStart)
    webview.addEventListener('did-stop-loading', onStop)
    webview.addEventListener('did-navigate', onNavigate)
    webview.addEventListener('did-navigate-in-page', onNavigate)
    webview.addEventListener('did-fail-load', onFail)

    return () => {
      webview.removeEventListener('ipc-message', onGuestExternal)
      webview.removeEventListener('did-start-loading', onStart)
      webview.removeEventListener('did-stop-loading', onStop)
      webview.removeEventListener('did-navigate', onNavigate)
      webview.removeEventListener('did-navigate-in-page', onNavigate)
      webview.removeEventListener('did-fail-load', onFail)
      host.replaceChildren()
    }
  }, [baseUrl, onState])

  // A reload ask steers the LIVE guest — same document history, same cookies;
  // only a service change (above) rebuilds it. 0 is the page's resting count,
  // so a fresh mount never reloads the guest it just built.
  useEffect(() => {
    if (reloadKey === 0) {
      return
    }

    ;(hostRef.current?.querySelector('webview') as GuestWebview | null)?.reload?.()
  }, [reloadKey])

  return <div className="h-full w-full" ref={hostRef} />
}
