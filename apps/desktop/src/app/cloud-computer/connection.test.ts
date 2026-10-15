import { atom, type WritableAtom } from 'nanostores'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { $accountAuth } from '@/store/account-auth'
import { $activeConnectionId } from '@/store/connections'
import { requestGatewayForAgent } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'

import { connectCloudComputer } from './connection'

vi.mock('@/store/account-auth', () => ({
  $accountAuth: atom({ phase: 'authenticated', user: { id: 'a', email: 'a@example.com', name: 'A' } })
}))
vi.mock('@/store/connections', () => ({ $activeConnectionId: atom('host-a') }))
vi.mock('@/store/profile', () => ({ $activeGatewayProfile: atom('work') }))
vi.mock('@/store/session', () => ({ $connection: atom({ baseUrl: 'https://host-a.test' }) }))
vi.mock('@/store/gateway', () => ({ requestGatewayForAgent: vi.fn() }))

const $profile = $activeGatewayProfile as WritableAtom<string | null>
const $connectionId = $activeConnectionId as WritableAtom<string | null>

beforeEach(() => {
  $connectionId.set('host-a')
  $profile.set('work')
  vi.mocked(requestGatewayForAgent).mockResolvedValue({
    enabled: true,
    agentEnabled: false,
    computer: null,
    lease: { holder: 'agent', epoch: 0, expiresAt: null }
  })
})
afterEach(() => {
  vi.clearAllMocks()
})

it('pins RPCs to the owning connection and profile and cannot retarget old work after a swap', async () => {
  const session = connectCloudComputer()

  try {
    await session.retry()
    expect(requestGatewayForAgent).toHaveBeenCalledWith(
      'host-a',
      'work',
      'cloudComputer.status',
      { profile: 'work' },
      60_000,
      expect.any(AbortSignal),
      { spawnPriority: 'foreground' }
    )
    $connectionId.set('host-b')
    $profile.set('other')
    await session.launch()
    expect(requestGatewayForAgent).toHaveBeenCalledTimes(1)
    expect(session.state.get().snapshot).toBeNull()
  } finally {
    session.dispose()
  }
})

it('synchronously revokes a mounted viewer during logout even if the same account logs back in', async () => {
  const session = connectCloudComputer()

  try {
    await session.retry()
    $accountAuth.set({ phase: 'checking', user: null })
    $accountAuth.set({ phase: 'authenticated', user: { id: 'a', email: 'a@example.com', name: 'A' } })
    await session.launch()
    expect(requestGatewayForAgent).toHaveBeenCalledTimes(1)
    expect(session.state.get().frame).toBeNull()
  } finally {
    session.dispose()
  }
})
