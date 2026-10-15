import { JsonRpcGatewayClient } from '@hermes/shared'

import type { AccountAuthUser } from '@/store/account-auth'

/**
 * Early-transport for the login gate. It dials the desktop's LOCAL gateway
 * (the agent subprocess) and forwards account auth to Better Auth through
 * it — the desktop never talks to bot-backend directly (doc《后端服务》§6/§7:
 * 所有后端请求统一经本地 Agent 子进程转发). The session credential stays
 * inside the agent process; only the verified user profile crosses back.
 *
 * This module must stay free of business imports: it runs BEFORE the
 * contribution shell (and its gateway boot) mounts.
 */

export interface AccountAuthStatus {
  authenticated: boolean
  user: AccountAuthUser | null
  /** Server-provided, form-displayable rejection message (never credentials). */
  error?: string | null
}

export type AccountAuthInvalidationReason = 'expired' | 'signed_out' | 'unavailable'

export interface AccountAuthTransport {
  status(): Promise<AccountAuthStatus>
  signIn(input: { email: string; password: string }): Promise<AccountAuthStatus>
  signUp(input: { name: string; email: string; password: string }): Promise<AccountAuthStatus>
  signOut(): Promise<void>
  onInvalidated?(handler: (reason: AccountAuthInvalidationReason) => void): () => void
  close?(): void
}

/** Raised when the agent bridge or the backend cannot be reached at all. */
export class AccountAuthUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('account auth service unavailable')
    this.name = 'AccountAuthUnavailableError'
    this.cause = cause
  }
}

export interface AccountAuthConnection {
  wsUrl: string
}

type ConnectionGetter = () => Promise<AccountAuthConnection>

interface AuthClientOptions {
  /** Injectable for tests; production dials the real socket. */
  clientFactory?: (wsUrl: string) => JsonRpcGatewayClient
}

export function createGatewayAccountAuthTransport(
  getConnection: ConnectionGetter,
  options: AuthClientOptions = {},
): AccountAuthTransport {
  let clientPromise: Promise<JsonRpcGatewayClient> | null = null
  let connectionGeneration = 0
  let activeClient: JsonRpcGatewayClient | null = null
  let unsubscribe: Array<() => void> = []
  const listeners = new Set<(reason: AccountAuthInvalidationReason) => void>()
  const notify = (reason: AccountAuthInvalidationReason) => listeners.forEach(handler => handler(reason))

  function close(): void {
    clientPromise = null
    connectionGeneration += 1
    unsubscribe.splice(0).forEach(stop => stop())
    const previous = activeClient
    activeClient = null
    previous?.close()
  }

  function client(): Promise<JsonRpcGatewayClient> {
    if (clientPromise) { return clientPromise }

    const generation = ++connectionGeneration
    const pending = (async () => {
      const connection = await getConnection()

      const gateway = options.clientFactory?.(connection.wsUrl) ?? new JsonRpcGatewayClient({
        requestIdPrefix: 'auth', replay: false
      })

      // A stopped gate must not reopen its old socket after getConnection resolves.
      if (generation !== connectionGeneration) { throw new AccountAuthUnavailableError() }
      activeClient = gateway
      unsubscribe = [
        gateway.on('accountAuth.invalidated', event => {
          notify(event.payload?.reason ?? 'expired')
        }),
        gateway.onState(state => {
          if (state === 'closed' || state === 'error') {
            close()
            notify('unavailable')
          }
        })
      ]
      await gateway.connect(connection.wsUrl)

      return gateway
    })()

    clientPromise = pending

    return pending
  }

  async function request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const pending = client()

    try {
      const gateway = await pending

      return await gateway.request<T>(method, params)
    } catch (error) {
      if (clientPromise === pending) { close() }
      throw new AccountAuthUnavailableError(error)
    }
  }

  function toStatus(result: {
    authenticated?: boolean
    user?: AccountAuthUser | null
    error?: string | null
  }): AccountAuthStatus {
    return {
      authenticated: Boolean(result.authenticated),
      user: result.authenticated ? (result.user ?? null) : null,
      error: result.error ?? null
    }
  }

  return {
    close,
    onInvalidated(handler) {
      listeners.add(handler)

      return () => listeners.delete(handler)
    },
    async status(): Promise<AccountAuthStatus> {
      return toStatus(await request('accountAuth.status', {}))
    },
    async signIn(input: { email: string; password: string }): Promise<AccountAuthStatus> {
      return toStatus(await request('accountAuth.signIn', input))
    },
    async signUp(input: { name: string; email: string; password: string }): Promise<AccountAuthStatus> {
      return toStatus(await request('accountAuth.signUp', input))
    },
    async signOut(): Promise<void> {
      await request('accountAuth.signOut', {})
    }
  }
}
