import { atom } from 'nanostores'

/**
 * Login-gate state (doc《用户认证》§2): the renderer renders the auth window
 * instead of the app until the server-side session is confirmed. The phase
 * machine is deliberately tiny — the credential itself never reaches the
 * renderer (doc《后端服务》§6: 所有后端请求经本地 Agent 子进程转发，桌面不直连).
 */
export type AccountAuthPhase =
  /** Startup: asking the agent subprocess for the current session. */
  | 'checking'
  /** No valid session: show the login / register forms. */
  | 'unauthenticated'
  /** The account service is unreachable (agent bridge or backend down). */
  | 'unavailable'
  /** Server-confirmed session: mount the app. */
  | 'authenticated'

export interface AccountAuthUser {
  id: string
  email: string
  name: string
}

export interface AccountAuthState {
  phase: AccountAuthPhase
  user: AccountAuthUser | null
}

export const $accountAuth = atom<AccountAuthState>({ phase: 'checking', user: null })

export function setAccountAuthState(state: AccountAuthState): void {
  $accountAuth.set(state)
}
