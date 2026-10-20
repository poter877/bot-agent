import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { registry } from '@/contrib/registry'
import { I18nProvider } from '@/i18n'

import { appViewForPath, ROUTES_AREA, SIDEBAR_NAV_AREA } from '../routes'

import { DramaContributions } from './contributions'
import { DramaPage } from './page'

// page 现在挂载前先取 serve 连接信息；测试给一个最小桩。
vi.stubGlobal('window', Object.assign(window, {
  hermesDesktop: { getConnection: () => Promise.resolve({ baseUrl: 'http://127.0.0.1:1', token: 't' }) }
}))

vi.mock('@drama/embed', () => ({
  DramaApp: (props: { initialPath?: string }) => (
    <div data-drama-app data-initial-path={props.initialPath} />
  )
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('mounts the studio frontend in its own root — no webview, no nested router', async () => {
  const { container } = render(
    <I18nProvider configClient={null} initialLocale="en">
      <DramaPage />
    </I18nProvider>
  )

  const app = await waitFor(() => {
    const el = container.querySelector('[data-drama-app]')

    expect(el).toBeTruthy()

    return el as HTMLElement
  })

  expect(app.getAttribute('data-initial-path')).toBe('/')

  // The embed is a native mount: no <webview> guest anywhere on the page.
  expect(container.querySelector('webview')).toBeNull()

  // The one token both design systems define is re-pinned to the drama value
  // on the page container.
  expect(app.parentElement?.getAttribute('style')).toContain('--color-input')
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
