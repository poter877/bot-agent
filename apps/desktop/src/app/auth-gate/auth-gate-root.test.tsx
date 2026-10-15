import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { $accountAuth } from '@/store/account-auth'

import { type AccountAuthTransport, AccountAuthUnavailableError } from './account-auth-transport'
import { AuthGate } from './auth-gate-root'

const USER = { id: 'u1', email: 'user@test.local', name: 'User' }

function fakeTransport(overrides: Partial<AccountAuthTransport> = {}): AccountAuthTransport {
  return {
    status: vi.fn().mockResolvedValue({ authenticated: false, user: null }),
    signIn: vi.fn().mockResolvedValue({ authenticated: true, user: USER }),
    signUp: vi.fn().mockResolvedValue({ authenticated: true, user: USER }),
    signOut: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }
}

describe('AuthGate', () => {
  beforeEach(() => {
    act(() => {
      $accountAuth.set({ phase: 'checking', user: null })
    })
  })

  it('renders only the checking state, never the app, before the session is confirmed', async () => {
    let resolveStatus: ((value: { authenticated: boolean; user: typeof USER | null }) => void) | null = null

    const transport = fakeTransport({
      status: vi.fn().mockImplementation(
        () => new Promise<{ authenticated: boolean }>(resolve => {
          resolveStatus = resolve
        })
      )
    })

    render(
      <AuthGate transport={transport}>
        <div>business-shell</div>
      </AuthGate>,
      { wrapper: undefined }
    )

    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.queryByText('business-shell')).toBeNull()

    await act(async () => {
      resolveStatus!({ authenticated: true, user: USER })
    })
    await waitFor(() => expect(screen.getByText('business-shell')).toBeTruthy())
  })

  it('shows the login form when unauthenticated and signs in on submit', async () => {
    const transport = fakeTransport({
      status: vi
        .fn()
        .mockResolvedValueOnce({ authenticated: false, user: null })
        .mockResolvedValue({ authenticated: true, user: USER })
    })

    render(
      <AuthGate transport={transport}>
        <div>business-shell</div>
      </AuthGate>,
      { wrapper: undefined }
    )

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy())
    expect(screen.queryByText('business-shell')).toBeNull()

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@test.local' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-pass' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => expect(screen.getByText('business-shell')).toBeTruthy())
    expect(transport.signIn).toHaveBeenCalledWith({ email: 'user@test.local', password: 'secret-pass' })
  })

  it('keeps the gate with a retry affordance when the account service is unreachable', async () => {
    const transport = fakeTransport({ status: vi.fn().mockRejectedValue(new AccountAuthUnavailableError()) })

    render(
      <AuthGate transport={transport}>
        <div>business-shell</div>
      </AuthGate>,
      { wrapper: undefined }
    )

    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy())
    expect(screen.queryByText('business-shell')).toBeNull()

    const recovered = fakeTransport({ status: vi.fn().mockResolvedValue({ authenticated: true, user: USER }) })
    vi.mocked(transport.status).mockImplementation(recovered.status)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText('business-shell')).toBeTruthy())
  })

  it('rejects mismatched confirmation client-side without calling the transport', async () => {
    const transport = fakeTransport({ status: vi.fn().mockResolvedValue({ authenticated: false, user: null }) })

    render(
      <AuthGate transport={transport}>
        <div>business-shell</div>
      </AuthGate>,
      { wrapper: undefined }
    )

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'No account? Create one' }))

    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'User' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@test.local' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'long-enough-pass' } })
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'different-pass' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByText("Passwords don't match")).toBeTruthy()
    expect(transport.signUp).not.toHaveBeenCalled()
  })
})

it('rechecks on focus and removes the mounted app when the server revokes the session', async () => {
  const transport = fakeTransport({
    status: vi.fn()
      .mockResolvedValueOnce({ authenticated: true, user: USER })
      .mockResolvedValue({ authenticated: false, user: null })
  })

  const reset = vi.fn()
  render(<AuthGate resetBusinessState={reset} transport={transport}><div>business-shell</div></AuthGate>)
  await screen.findByText('business-shell')
  fireEvent(window, new Event('focus'))
  await screen.findByRole('heading', { name: 'Sign in' })
  expect(screen.queryByText('business-shell')).toBeNull()
  expect(reset).toHaveBeenCalledOnce()
})

it('connects the visible sign-out action to account revocation and removes the business UI', async () => {
  const { AccountSignOutAction } = await import('./account-sign-out-action')
  const transport = fakeTransport({ status: vi.fn().mockResolvedValue({ authenticated: true, user: USER }) })
  const reset = vi.fn()
  render(
    <AuthGate resetBusinessState={reset} transport={transport}>
      <div>business-shell</div><AccountSignOutAction />
    </AuthGate>
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
  await screen.findByRole('heading', { name: 'Sign in' })
  expect(screen.queryByText('business-shell')).toBeNull()
  expect(transport.signOut).toHaveBeenCalledOnce()
  expect(reset).toHaveBeenCalledOnce()
})
