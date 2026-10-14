import { useStore } from '@nanostores/react'
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import {
  $accountAuth,
  setAccountAuthState
} from '@/store/account-auth'

import {
  type AccountAuthTransport,
  AccountAuthUnavailableError,
  createGatewayAccountAuthTransport
} from './account-auth-transport'

/**
 * The login gate (doc《用户认证》§2/§4): while the account session is
 * unconfirmed the renderer shows ONLY this window — the business shell (and
 * its gateway boot) stays unmounted, it is not covered by an overlay. The
 * confirmed identity comes from the agent subprocess's server-side check.
 */
export function AuthGate({
  children,
  transport: injectedTransport
}: {
  children: ReactNode
  /** Test seam; production dials the local gateway's accountAuth.* methods. */
  transport?: AccountAuthTransport
}) {
  const { t } = useI18n()
  const state = useStore($accountAuth)

  const transport = useMemo(
    () => injectedTransport ?? createGatewayAccountAuthTransport(() => window.hermesDesktop.getConnection()),
    [injectedTransport]
  )

  const runCheck = useCallback(() => {
    setAccountAuthState({ phase: 'checking', user: null })
    transport
      .status()
      .then(status =>
        setAccountAuthState(
          status.authenticated && status.user
            ? { phase: 'authenticated', user: status.user }
            : { phase: 'unauthenticated', user: null }
        )
      )
      .catch(() => setAccountAuthState({ phase: 'unavailable', user: null }))
  }, [transport])

  useEffect(() => {
    runCheck()
  }, [runCheck])

  if (state.phase === 'authenticated') {
    return <>{children}</>
  }

  return (
    <AuthWindow
      checkingLabel={t.accountAuth.checking}
      onAuthenticated={() => runCheck()}
      onRetry={runCheck}
      phase={state.phase}
      retryLabel={t.accountAuth.retry}
      transport={transport}
    />
  )
}

type AuthWindowProps = {
  phase: 'checking' | 'unauthenticated' | 'unavailable'
  transport: AccountAuthTransport
  onAuthenticated: () => void
  onRetry: () => void
  retryLabel: string
  checkingLabel: string
}

function AuthWindow({ phase, transport, onAuthenticated, onRetry, retryLabel, checkingLabel }: AuthWindowProps) {
  const { t } = useI18n()
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError(null)

    const data = new FormData(event.currentTarget)
    const email = String(data.get('email') ?? '').trim()
    const password = String(data.get('password') ?? '')

    if (mode === 'sign-up') {
      const name = String(data.get('name') ?? '').trim()
      const confirm = String(data.get('confirm') ?? '')

      if (confirm !== password) {
        setFormError(t.accountAuth.confirmPasswordMismatch)

        return
      }

      setSubmitting(true)

      try {
        const status = await transport.signUp({ name, email, password })

        if (status.authenticated && status.user) {
          onAuthenticated()

          return
        }

        setFormError(status.error ?? t.accountAuth.signUpFailed)
      } catch (error) {
        setFormError(
          error instanceof AccountAuthUnavailableError ? t.accountAuth.unavailableBody : t.accountAuth.signUpFailed
        )
      } finally {
        setSubmitting(false)
      }

      return
    }

    setSubmitting(true)

    try {
      const status = await transport.signIn({ email, password })

      if (status.authenticated && status.user) {
        onAuthenticated()

        return
      }

      setFormError(status.error ?? t.accountAuth.signInFailed)
    } catch (error) {
      setFormError(
        error instanceof AccountAuthUnavailableError ? t.accountAuth.unavailableBody : t.accountAuth.signInFailed
      )
    } finally {
      setSubmitting(false)
    }
  }

  if (phase === 'checking') {
    return (
      <AuthShell>
        <p role="status">{checkingLabel}</p>
      </AuthShell>
    )
  }

  if (phase === 'unavailable') {
    return (
      <AuthShell>
        <h1>{t.accountAuth.unavailableTitle}</h1>
        <p>{t.accountAuth.unavailableBody}</p>
        <Button onClick={onRetry}>{retryLabel}</Button>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <h1>{mode === 'sign-in' ? t.accountAuth.signInTitle : t.accountAuth.signUpTitle}</h1>
      <form onSubmit={event => void submit(event)}>
        {mode === 'sign-up' && (
          <label>
            {t.accountAuth.displayName}
            <Input autoComplete="name" disabled={submitting} maxLength={64} name="name" required type="text" />
          </label>
        )}
        <label>
          {t.accountAuth.email}
          <Input autoComplete="email" disabled={submitting} name="email" required type="email" />
        </label>
        <label>
          {t.accountAuth.password}
          <Input
            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            disabled={submitting}
            minLength={8}
            name="password"
            required
            type="password"
          />
        </label>
        {mode === 'sign-up' && (
          <label>
            {t.accountAuth.confirmPassword}
            <Input autoComplete="new-password" disabled={submitting} name="confirm" required type="password" />
          </label>
        )}
        {formError && (
          <p className="text-destructive" role="alert">
            {formError}
          </p>
        )}
        <Button disabled={submitting} type="submit">
          {mode === 'sign-in' ? t.accountAuth.signInAction : t.accountAuth.signUpAction}
        </Button>
      </form>
      <Button onClick={() => setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')} variant="ghost">
        {mode === 'sign-in' ? t.accountAuth.switchToSignUp : t.accountAuth.switchToSignIn}
      </Button>
    </AuthShell>
  )
}

function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground">
      <div className="flex w-full max-w-sm flex-col gap-4 p-8">{children}</div>
    </div>
  )
}
