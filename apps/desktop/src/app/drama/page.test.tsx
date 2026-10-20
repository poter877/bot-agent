import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { registry } from '@/contrib/registry'
import { I18nProvider } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'

import { appViewForPath, ROUTES_AREA, SIDEBAR_NAV_AREA } from '../routes'

import { DramaContributions } from './contributions'
import { DramaPage } from './page'
import { $dramaBaseUrl, DEFAULT_DRAMA_BASE_URL } from './url'

vi.mock('@/lib/external-link', () => ({ openExternalLink: vi.fn() }))

/** An Electron guest event — DOM event shape plus Electron's detail fields. */
function guestEvent(type: string, detail: Record<string, unknown>): Event {
  const event = new Event(type)

  Object.assign(event, detail)

  return event
}

function page() {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <DramaPage />
    </I18nProvider>
  )
}

function guestElement(container: HTMLElement): HTMLElement & { reload: () => void } {
  const webview = container.querySelector('webview')

  if (!webview) {
    throw new Error('webview guest not mounted')
  }

  return webview as HTMLElement & { reload: () => void }
}

beforeEach(() => {
  localStorage.clear()
  $dramaBaseUrl.set(DEFAULT_DRAMA_BASE_URL)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('embeds the studio on the shared preview guest contract', () => {
  const { container } = page()
  const webview = guestElement(container)

  expect(webview.getAttribute('partition')).toBe('persist:hermes-preview')
  expect(webview.getAttribute('src')).toBe('http://localhost:30172')
  expect(webview.getAttribute('webpreferences')).toBe('contextIsolation=yes,nodeIntegration=no,sandbox=yes')
  // No popups: a guest _blank must go through the trusted-click bridge only.
  expect(webview.hasAttribute('allowpopups')).toBe(false)

  // The load overlay stands down once the guest reports it stopped loading.
  expect(screen.getByRole('status')).toBeTruthy()
  act(() => {
    webview.dispatchEvent(guestEvent('did-stop-loading', {}))
  })
  expect(screen.queryByRole('status')).toBeNull()
})

it('surfaces an unreachable guest with a way out, and retry reloads the live guest', () => {
  const { container } = page()
  const webview = guestElement(container)
  const reload = vi.fn()

  Object.assign(webview, { reload })

  act(() => {
    webview.dispatchEvent(
      guestEvent('did-fail-load', {
        errorCode: -102,
        errorDescription: 'ERR_CONNECTION_REFUSED',
        isMainFrame: true,
        validatedURL: 'http://localhost:30172/'
      })
    )
  })

  expect(screen.getByText('Cannot reach the video studio')).toBeTruthy()
  expect(screen.getByText('ERR_CONNECTION_REFUSED')).toBeTruthy()

  // A subframe failure never covers a healthy page.
  act(() => {
    webview.dispatchEvent(guestEvent('did-fail-load', { errorCode: -6, isMainFrame: false }))
  })
  expect(screen.getByText('Cannot reach the video studio')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(reload).toHaveBeenCalledOnce()
  expect(screen.getByRole('status')).toBeTruthy()
})

it('admits only web links from the guest trusted-click bridge', () => {
  const { container } = page()
  const webview = guestElement(container)

  webview.dispatchEvent(guestEvent('ipc-message', { channel: 'other-channel', args: ['https://example.com'] }))
  webview.dispatchEvent(guestEvent('ipc-message', { channel: 'preview-open-external', args: ['file:///etc/passwd'] }))
  expect(openExternalLink).not.toHaveBeenCalled()

  webview.dispatchEvent(guestEvent('ipc-message', { channel: 'preview-open-external', args: ['https://example.com'] }))
  expect(openExternalLink).toHaveBeenCalledWith('https://example.com')
})

it('saves only a valid service address, then rebuilds the guest on it', () => {
  const { container } = page()

  fireEvent.click(screen.getByRole('button', { name: 'Change address' }))
  const input = screen.getByLabelText('Service address')

  fireEvent.change(input, { target: { value: 'not a url' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(screen.getByText('Enter an http(s) address, e.g. http://localhost:30172')).toBeTruthy()
  expect($dramaBaseUrl.get()).toBe('http://localhost:30172')

  fireEvent.change(input, { target: { value: 'bot-backend.corp:9119/studio' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))

  expect($dramaBaseUrl.get()).toBe('http://bot-backend.corp:9119')
  expect(screen.getByText('http://bot-backend.corp:9119')).toBeTruthy()
  expect(screen.queryByLabelText('Service address')).toBeNull()
  expect(guestElement(container).getAttribute('src')).toBe('http://bot-backend.corp:9119')
})

it('registers a translated sidebar entry and workspace page, then removes both on unmount', async () => {
  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <DramaContributions />
    </I18nProvider>
  )

  await waitFor(() =>
    expect(registry.getArea(SIDEBAR_NAV_AREA).find(row => row.id === 'drama:nav')?.data).toMatchObject({
      codicon: 'device-camera-video',
      label: '视频工厂',
      path: '/drama'
    })
  )

  const route = registry.getArea(ROUTES_AREA).find(row => row.id === 'drama:page')

  expect(route?.data).toMatchObject({ path: '/drama' })
  expect(route?.render).toBeTypeOf('function')
  // A contributed path classifies as a full page, never as a session route.
  expect(appViewForPath('/drama')).toBe('extension')

  view.unmount()

  expect(registry.getArea(SIDEBAR_NAV_AREA).find(row => row.id === 'drama:nav')).toBeUndefined()
  expect(registry.getArea(ROUTES_AREA).find(row => row.id === 'drama:page')).toBeUndefined()
})
