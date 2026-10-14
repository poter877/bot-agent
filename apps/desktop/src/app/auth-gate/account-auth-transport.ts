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

export interface AccountAuthTransport {
  status(): Promise<AccountAuthStatus>
  signIn(input: { email: string; password: string }): Promise<AccountAuthStatus>
  signUp(input: { name: string; email: string; password: string }): Promise<AccountAuthStatus>
  signOut(): Promise<void>
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

// JSON-RPC standard "method not found" — the gateway predates the accountAuth
// methods (older runtime), which is an availability problem for the gate.
const RPC_METHOD_NOT_FOUND = -32601

function toUnavailable(error: unknown): AccountAuthUnavailableError {
  if (error instanceof AccountAuthUnavailableError) {return error}
  const code = (error as { code?: unknown })?.code
  const message = error instanceof Error ? error.message : String(error)

  if (code === RPC_METHOD_NOT_FOUND || /not found|unknown method/i.test(message)) {
    return new AccountAuthUnavailableError(error)
  }

  // Connection-level failures surface as plain Errors from the channel.
  if (!(error instanceof Error) || /closed|connect|offline|network/i.test(message)) {
    return new AccountAuthUnavailableError(error)
  }

  return new AccountAuthUnavailableError(error)
}

export function createGatewayAccountAuthTransport(
  getConnection: ConnectionGetter,
  options: AuthClientOptions = {},
): AccountAuthTransport {
  let clientPromise: Promise<JsonRpcGatewayClient> | null = null

  async function client(): Promise<JsonRpcGatewayClient> {
    clientPromise ??= (async () => {
      const connection = await getConnection()

      const client =
        options.clientFactory?.(connection.wsUrl) ??
        new JsonRpcGatewayClient({
          requestIdPrefix: 'auth',
          // The gate tracks no sessions; a lossless replay is dead weight here.
          replay: false
        })

      await client.connect(connection.wsUrl)

      return client
    })()

    return clientPromise
  }

  async function request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    try {
      const gateway = await client()

      return await gateway.request<T>(method, params)
    } catch (error) {
      throw toUnavailable(error)
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
