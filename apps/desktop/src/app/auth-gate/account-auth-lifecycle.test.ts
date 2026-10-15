import { beforeEach, describe, expect, it, vi } from 'vitest'

import { $accountAuth } from '@/store/account-auth'

import { createAccountAuthLifecycle } from './account-auth-lifecycle'
import type { AccountAuthTransport } from './account-auth-transport'

const user = { id: 'user', email: 'user@example.com', name: 'User' }
const signedIn = { authenticated: true, user }

function setup() {
  let invalidate: (reason: 'expired' | 'signed_out' | 'unavailable') => void = () => {}

  const transport: AccountAuthTransport = {
    status: vi.fn().mockResolvedValue(signedIn),
    signIn: vi.fn().mockResolvedValue(signedIn),
    signUp: vi.fn().mockResolvedValue(signedIn),
    signOut: vi.fn().mockResolvedValue(undefined),
    onInvalidated: vi.fn(handler => { invalidate = handler;

 return () => {} })
  }

  const reset = vi.fn()
  const lifecycle = createAccountAuthLifecycle(transport, reset)
  lifecycle.start()

  return { transport, reset, lifecycle, invalidate: (reason: 'expired' | 'signed_out' | 'unavailable') => invalidate(reason) }
}

beforeEach(() => $accountAuth.set({ phase: 'checking', user: null }))

describe('account authentication lifecycle', () => {
  it('removes business access on invalidation and ignores a stale successful status response', async () => {
    const { lifecycle, transport, invalidate, reset } = setup()
    await lifecycle.check()
    let resolve!: (value: typeof signedIn) => void
    vi.mocked(transport.status).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const pending = lifecycle.check()
    invalidate('expired')
    expect($accountAuth.get().phase).toBe('unauthenticated')
    expect(reset).toHaveBeenCalledOnce()
    resolve(signedIn)
    await pending
    expect($accountAuth.get().user).toBeNull()
    lifecycle.stop()
  })

  it('fails closed during logout, resets only after revocation, and ignores older login responses', async () => {
    const { lifecycle, transport, reset } = setup()
    await lifecycle.check()
    let resolve!: (value: typeof signedIn) => void
    vi.mocked(transport.signIn).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const oldLogin = lifecycle.transport.signIn({ email: user.email, password: 'password' })
    let revoke!: () => void
    vi.mocked(transport.signOut).mockImplementationOnce(() => new Promise(done => { revoke = done }))
    const signOut = lifecycle.signOut()
    expect($accountAuth.get().phase).not.toBe('authenticated')
    expect(reset).not.toHaveBeenCalled()
    revoke()
    await signOut
    resolve(signedIn)
    expect((await oldLogin).authenticated).toBe(false)
    expect($accountAuth.get().phase).toBe('unauthenticated')
    expect(reset).toHaveBeenCalledOnce()
    lifecycle.stop()
  })

  it('retries a failed sign-out instead of accepting the still-valid cookie', async () => {
    const { lifecycle, transport, reset } = setup()
    await lifecycle.check()
    vi.mocked(transport.signOut).mockRejectedValueOnce(new Error('socket closed'))
    await lifecycle.signOut()
    expect($accountAuth.get().phase).toBe('unavailable')
    expect(reset).not.toHaveBeenCalled()
    await lifecycle.check()
    expect(transport.signOut).toHaveBeenCalledTimes(2)
    expect(transport.status).toHaveBeenCalledOnce()
    expect($accountAuth.get().phase).toBe('unauthenticated')
    expect(reset).toHaveBeenCalledOnce()
    lifecycle.stop()
  })

  it('blocks business access when a background check loses the account service', async () => {
    const { lifecycle, transport, reset } = setup()
    await lifecycle.check()
    vi.mocked(transport.status).mockRejectedValueOnce(new Error('offline'))
    await lifecycle.check()
    expect($accountAuth.get().phase).toBe('unavailable')
    expect(reset).toHaveBeenCalledOnce()
    lifecycle.stop()
  })
})
