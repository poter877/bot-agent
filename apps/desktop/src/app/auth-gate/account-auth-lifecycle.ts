import { setAccountAuthState } from '@/store/account-auth'

import type { AccountAuthInvalidationReason, AccountAuthStatus, AccountAuthTransport } from './account-auth-transport'

const signedOut: AccountAuthStatus = { authenticated: false, user: null }
let currentSignOut: (() => Promise<void>) | undefined

export async function signOutAccount(): Promise<void> {
  await currentSignOut?.()
}

/** The account credential stays in Python; this generation protects its renderer cache. */
export function createAccountAuthLifecycle(backend: AccountAuthTransport, resetBusinessState: () => void) {
  let generation = 0
  let active = false
  let businessMounted = false
  let signingOut = false
  let signOutPending = false
  let unsubscribe: (() => void) | undefined

  function reset(): void {
    if (!businessMounted) { return }
    businessMounted = false
    resetBusinessState()
  }

  function invalidate(reason: AccountAuthInvalidationReason): void {
    if (!active || signingOut) { return }
    generation += 1
    setAccountAuthState({ phase: reason === 'unavailable' ? 'unavailable' : 'unauthenticated', user: null })
    reset()
  }

  async function check(): Promise<void> {
    if (!active || signingOut) { return }

    if (signOutPending) { return signOut() }
    const ticket = ++generation

    if (!businessMounted) { setAccountAuthState({ phase: 'checking', user: null }) }

    try {
      const status = await backend.status()

      if (!active || ticket !== generation) { return }

      if (status.authenticated && status.user) {
        businessMounted = true
        setAccountAuthState({ phase: 'authenticated', user: status.user })
      } else {
        invalidate('expired')
      }
    } catch {
      if (active && ticket === generation) { invalidate('unavailable') }
    }
  }

  async function authenticate(run: () => Promise<AccountAuthStatus>): Promise<AccountAuthStatus> {
    const ticket = ++generation
    const result = await run()

    return active && ticket === generation ? result : signedOut
  }

  async function signOut(): Promise<void> {
    if (!active || signingOut) { return }
    generation += 1
    signingOut = true
    signOutPending = true
    setAccountAuthState({ phase: 'checking', user: null })

    try {
      await backend.signOut()

      if (!active) { return }
      signOutPending = false
      setAccountAuthState({ phase: 'unauthenticated', user: null })
      reset()
    } catch {
      // Retry must retry revocation, never silently accept the previous cookie.
      if (active) { setAccountAuthState({ phase: 'unavailable', user: null }) }
    } finally {
      signingOut = false
    }
  }

  const transport: AccountAuthTransport = {
    status: backend.status,
    signIn: input => authenticate(() => backend.signIn(input)),
    signUp: input => authenticate(() => backend.signUp(input)),
    signOut
  }

  return {
    transport,
    offline() { invalidate('unavailable') },
    check,
    signOut,
    start() {
      active = true
      currentSignOut = signOut
      unsubscribe = backend.onInvalidated?.(invalidate)
    },
    stop() {
      active = false
      generation += 1
      unsubscribe?.()
      backend.close?.()

      if (currentSignOut === signOut) { currentSignOut = undefined }
    },
    revalidate() {
      // 认证门之外（如 unavailable）聚焦/网络恢复同样触发检查——
      // 后端恢复后无需手动点重试
      void check()
    }
  }
}
