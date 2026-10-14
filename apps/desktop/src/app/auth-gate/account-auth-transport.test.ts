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
