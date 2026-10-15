import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AccountAuthUnavailableError,
  createGatewayAccountAuthTransport
} from './account-auth-transport'

const USER = { id: 'u1', email: 'user@test.local', name: 'User' }

/** Minimal stub of the shared WS client: records requests, replays canned results. */
function fakeClient(results: { method: string; value?: unknown; error?: unknown }[]) {
  const requests: Array<{ method: string; params: unknown }> = []

  return {
    requests,
    client: {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      on: vi.fn((_type: string, _handler: (event: unknown) => void) => () => {}),
      onState: vi.fn((_handler: (state: string) => void) => () => {}),
      request: vi.fn(async (method: string, params: unknown) => {
        requests.push({ method, params })
        const hit = results.find(entry => entry.method === method)

        if (hit === undefined) {throw new Error(`no stub for ${method}`)}

        if (hit.error !== undefined) {throw hit.error}

        return hit.value
      })
    }
  }
}

describe('gateway account-auth transport', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('dialls the connection ws url and relays accountAuth.status', async () => {
    const { requests, client } = fakeClient([
      { method: 'accountAuth.status', value: { authenticated: true, user: USER } }
    ])

    const getConnection = vi.fn().mockResolvedValue({ wsUrl: 'ws://127.0.0.1:1/ws' })

    const transport = createGatewayAccountAuthTransport(getConnection, {
      clientFactory: () => client as never
    })

    const status = await transport.status()

    expect(getConnection).toHaveBeenCalledOnce()
    expect(client.connect).toHaveBeenCalledWith('ws://127.0.0.1:1/ws')
    expect(requests[0]).toEqual({ method: 'accountAuth.status', params: {} })
    expect(status).toEqual({ authenticated: true, user: USER, error: null })
  })

  it('creates a fresh connection after a rejected initial connection promise', async () => {
    const { client } = fakeClient([
      { method: 'accountAuth.status', value: { authenticated: true, user: USER } }
    ])

    const getConnection = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ wsUrl: 'ws://recovered' })

    const transport = createGatewayAccountAuthTransport(getConnection, {
      clientFactory: () => client as never
    })

    await expect(transport.status()).rejects.toBeInstanceOf(AccountAuthUnavailableError)
    expect((await transport.status()).authenticated).toBe(true)
    expect(getConnection).toHaveBeenCalledTimes(2)
  })

  it('forwards account invalidation and reconnects after the auth socket closes', async () => {
    const first = fakeClient([{ method: 'accountAuth.status', value: { authenticated: true, user: USER } }]).client
    const second = fakeClient([{ method: 'accountAuth.status', value: { authenticated: false } }]).client
    let onEvent!: (event: unknown) => void
    let onState!: (state: string) => void
    first.on.mockImplementation((_type, handler) => { onEvent = handler;

 return () => {} })
    first.onState.mockImplementation(handler => { onState = handler;

 return () => {} })
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const transport = createGatewayAccountAuthTransport(async () => ({ wsUrl: 'ws://local' }), { clientFactory: factory })
    const invalidated = vi.fn()
    transport.onInvalidated?.(invalidated)
    await transport.status()
    onEvent({ type: 'accountAuth.invalidated', payload: { reason: 'expired' } })
    expect(invalidated).toHaveBeenCalledWith('expired')
    onState('closed')
    expect(invalidated).toHaveBeenCalledWith('unavailable')
    expect((await transport.status()).authenticated).toBe(false)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('signs in through the agent bridge and reports the confirmed user', async () => {
    const { requests, client } = fakeClient([
      { method: 'accountAuth.signIn', value: { authenticated: true, user: USER } }
    ])

    const transport = createGatewayAccountAuthTransport(vi.fn().mockResolvedValue({ wsUrl: 'ws://x' }), {
      clientFactory: () => client as never
    })

    const status = await transport.signIn({ email: 'user@test.local', password: 'secret-pass' })

    expect(requests[0]?.method).toBe('accountAuth.signIn')
    expect(requests[0]?.params).toEqual({ email: 'user@test.local', password: 'secret-pass' })
    expect(status.authenticated).toBe(true)
    expect(status.user?.email).toBe('user@test.local')
  })

  it('carries the server rejection message so the form can show it', async () => {
    const { client } = fakeClient([
      { method: 'accountAuth.signIn', value: { authenticated: false, error: 'Invalid email or password' } }
    ])

    const transport = createGatewayAccountAuthTransport(vi.fn().mockResolvedValue({ wsUrl: 'ws://x' }), {
      clientFactory: () => client as never
    })

    const status = await transport.signIn({ email: 'user@test.local', password: 'wrong' })
    expect(status.authenticated).toBe(false)
    expect(status.error).toBe('Invalid email or password')
  })

  it('maps a missing gateway method to the unavailable error (older runtime)', async () => {
    const { client } = fakeClient([
      { method: 'accountAuth.status', error: { code: -32601, message: 'Method not found' } }
    ])

    const transport = createGatewayAccountAuthTransport(vi.fn().mockResolvedValue({ wsUrl: 'ws://x' }), {
      clientFactory: () => client as never
    })

    await expect(transport.status()).rejects.toBeInstanceOf(AccountAuthUnavailableError)
  })

  it('maps a dead socket to the unavailable error instead of a form error', async () => {
    const { client } = fakeClient([
      { method: 'accountAuth.status', error: new Error('WebSocket closed') }
    ])

    const transport = createGatewayAccountAuthTransport(vi.fn().mockResolvedValue({ wsUrl: 'ws://x' }), {
      clientFactory: () => client as never
    })

    await expect(transport.status()).rejects.toBeInstanceOf(AccountAuthUnavailableError)
  })
})
