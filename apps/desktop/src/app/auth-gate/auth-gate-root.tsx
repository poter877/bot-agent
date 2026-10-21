import { useStore } from '@nanostores/react'
import { Loader2 } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { $accountAuth } from '@/store/account-auth'

import { createAccountAuthLifecycle } from './account-auth-lifecycle'
import {
  type AccountAuthTransport,
  AccountAuthUnavailableError,
  createGatewayAccountAuthTransport
} from './account-auth-transport'

/** Self-heal cadence for an unreachable account service: the first probes of
 *  a cold boot race the local backend's spawn (a renderer reload retires the
 *  old backend; the replacement needs seconds to listen), and a live session
 *  can lose its socket the same way. A backend restart or deploy can outlast
 *  any fixed probe budget — stranding the user on an error screen that only a
 *  manual button resurrects is worse than one lightweight status probe per
 *  interval — so the gate retries indefinitely with exponential backoff
 *  (4s doubling to a 60s ceiling). */
const UNAVAILABLE_RETRY_BASE_MS = 4_000
const UNAVAILABLE_RETRY_MAX_MS = 60_000

/**
 * The login gate (doc《用户认证》§2/§4): while the account session is
 * unconfirmed the renderer shows ONLY this window — the business shell (and
 * its gateway boot) stays unmounted, it is not covered by an overlay. The
 * confirmed identity comes from the agent subprocess's server-side check.
 */
export function AuthGate({
  children,
  transport: injectedTransport,
  resetBusinessState = reloadAccountSurface
}: {
  children: ReactNode
  /** Test seam; production dials the local gateway's accountAuth.* methods. */
  transport?: AccountAuthTransport
  resetBusinessState?: () => void
}) {
  const { t } = useI18n()
  const state = useStore($accountAuth)

  const transport = useMemo(
    () => injectedTransport ?? createGatewayAccountAuthTransport(() => window.hermesDesktop.getConnection()),
    [injectedTransport]
  )

  const lifecycle = useMemo(() => createAccountAuthLifecycle(transport, resetBusinessState), [transport, resetBusinessState])

  useEffect(() => {
    lifecycle.start()
    void lifecycle.check()
    const revalidate = () => lifecycle.revalidate()
    const interval = window.setInterval(revalidate, 30_000)
    window.addEventListener('focus', revalidate)
    window.addEventListener('online', revalidate)
    const offline = () => lifecycle.offline()
    window.addEventListener('offline', offline)

    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', revalidate)
      window.removeEventListener('online', revalidate)
      window.removeEventListener('offline', offline)
      lifecycle.stop()
    }
  }, [lifecycle])

  // Self-heal: an `unavailable` verdict schedules probes with exponential
  // backoff — unlimited attempts, the delay ceiling keeps it gentle. Success
  // resets the schedule. The manual 重试 always works regardless.
  useEffect(() => {
    let attempt = 0
    let timer: number | undefined

    const schedule = () => {
      if (timer !== undefined) { return }
      timer = window.setTimeout(
        () => {
          timer = undefined
          void lifecycle.check()
        },
        Math.min(UNAVAILABLE_RETRY_BASE_MS * 2 ** attempt, UNAVAILABLE_RETRY_MAX_MS)
      )
      attempt += 1
    }

    const stop = $accountAuth.subscribe(state => {
      if (timer !== undefined) {
        window.clearTimeout(timer)
        timer = undefined
      }

      if (state.phase === 'unavailable') {
        schedule()
      } else if (state.phase === 'authenticated') {
        attempt = 0
      }
    })

    return () => {
      stop()

      if (timer !== undefined) {
        window.clearTimeout(timer)
      }
    }
  }, [lifecycle])

  // 曾经认证过的会话：后端重启等瞬时不可用不再卸载业务面——只在顶部
  // 显示一条自动恢复中的横幅。冷启动（从未认证）仍走完整登录门。
  const [everAuthenticated, setEverAuthenticated] = useState(false)
  useEffect(() => {
    if (state.phase === 'authenticated') { setEverAuthenticated(true) }
  }, [state.phase])

  if (state.phase === 'authenticated') {
    return <>{children}</>
  }

  if (state.phase === 'unavailable' && everAuthenticated) {
    return (
      <>
        <div className="sticky top-0 z-50 flex items-center justify-center gap-2 bg-warning-soft px-3 py-1.5 text-xs text-warn-text" role="status">
          <Loader2 aria-hidden className="animate-spin" size={12} />
          {t.accountAuth.reconnecting}
        </div>
        {children}
      </>
    )
  }

  return (
    <AuthWindow
      checkingLabel={t.accountAuth.checking}
      onAuthenticated={() => { void lifecycle.check() }}
      onRetry={() => { void lifecycle.check() }}
      phase={state.phase}
      retryLabel={t.accountAuth.retry}
      transport={lifecycle.transport}
    />
  )
}

interface AuthWindowProps {
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

function reloadAccountSurface(): void {
  // A new identity must never inherit mounted stores, queries, terminals or old promises.
  // Durable profile work stays on disk; a fresh gate rechecks the server before mounting it.
  window.location.reload()
}
