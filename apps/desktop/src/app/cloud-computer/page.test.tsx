import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, expect, it, vi } from 'vitest'

import { registry } from '@/contrib/registry'
import { I18nProvider } from '@/i18n'
import { $accountAuth } from '@/store/account-auth'

import { ROUTES_AREA, SIDEBAR_NAV_AREA } from '../routes'

import { connectCloudComputer } from './connection'
import { CloudComputerContributions } from './contributions'
import { CloudComputerPage, CloudComputerView } from './page'
import type { CloudComputerSnapshot } from './protocol'
import type { CloudComputerViewState } from './session'

vi.mock('./connection', () => ({ connectCloudComputer: vi.fn() }))
vi.mock('@/store/account-auth', () => ({
  $accountAuth: atom({ phase: 'authenticated', user: { id: 'a', email: 'a@example.com', name: 'A' } })
}))
vi.mock('@/store/connections', () => ({ $activeConnectionId: atom('local') }))
vi.mock('@/store/profile', () => ({ $activeGatewayProfile: atom('default') }))
vi.mock('@/store/session', () => ({ $connection: atom({ baseUrl: 'http://localhost:8000' }) }))

const snapshot: CloudComputerSnapshot = {
  enabled: true,
  agentEnabled: false,
  computer: {
    id: 'desktop-a',
    state: 'stopped',
    generation: 1,
    width: 1280,
    height: 800,
    capabilities: { actions: ['click', 'type', 'key', 'scroll', 'move', 'drag'], capture: true },
    error: null
  },
  lease: { holder: 'agent', epoch: 0, expiresAt: null }
}

function viewer() {
  return {
    state: atom<CloudComputerViewState>({
      snapshot: structuredClone(snapshot),
      frame: null,
      controlling: false,
      busy: false,
      error: null
    }),
    launch: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    acquire: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    action: vi.fn(async () => {}),
    configure: vi.fn(async () => {}),
    start: vi.fn(),
    dispose: vi.fn()
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('offers account-scoped start/resume, control and new-chat configuration without enabling input for observers', async () => {
  const session = viewer()
  render(<CloudComputerView session={session} />)
  fireEvent.click(screen.getByRole('button', { name: 'Resume computer' }))
  expect(session.launch).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('checkbox'))
  expect(session.configure).toHaveBeenCalledWith(true)
  act(() =>
    session.state.set({
      ...session.state.get(),
      snapshot: { ...snapshot, computer: { ...snapshot.computer!, state: 'running' } },
      frame: {
        image: { mediaType: 'image/png', data: 'aW1hZ2U=', width: 1280, height: 800 },
        computerGeneration: 1,
        leaseEpoch: 0
      }
    })
  )
  expect(screen.getByRole('img', { name: 'Cloud computer screen' })).toBeTruthy()
  expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Take over' }))
  expect(session.acquire).toHaveBeenCalledOnce()
  act(() => session.state.set({ ...session.state.get(), controlling: true }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '你好，云电脑' } })
  fireEvent.click(screen.getByRole('button', { name: 'Type text' }))
  expect(session.action).toHaveBeenCalledWith({ action: 'type', params: { text: '你好，云电脑' } })
  fireEvent.click(screen.getByRole('button', { name: 'Hand back to assistant' }))
  expect(session.release).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Stop computer' }))
  expect(session.stop).toHaveBeenCalledOnce()
})

it('removes the old screen and disposes its viewer when the account changes', async () => {
  const old = viewer()
  const next = viewer()
  vi.mocked(connectCloudComputer).mockReturnValueOnce(old).mockReturnValueOnce(next)
  render(<CloudComputerPage />)
  await waitFor(() => expect(old.start).toHaveBeenCalledOnce())
  act(() => $accountAuth.set({ phase: 'authenticated', user: { id: 'b', email: 'b@example.com', name: 'B' } }))
  await waitFor(() => expect(old.dispose).toHaveBeenCalledOnce())
  expect(next.start).toHaveBeenCalledOnce()
})

it('registers a translated sidebar entry and workspace page, then removes both on unmount', async () => {
  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <CloudComputerContributions />
    </I18nProvider>
  )

  await waitFor(() =>
    expect(registry.getArea(SIDEBAR_NAV_AREA).find(row => row.id === 'cloud-computer:nav')?.data).toMatchObject({
      label: '云电脑',
      path: '/cloud-computer'
    })
  )
  expect(registry.getArea(ROUTES_AREA).find(row => row.id === 'cloud-computer:page')?.render).toBeTypeOf('function')
  view.unmount()
  expect(registry.getArea(SIDEBAR_NAV_AREA).find(row => row.id === 'cloud-computer:nav')).toBeUndefined()
})
