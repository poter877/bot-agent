import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { EmptyState } from '@/components/ui/empty-state'
import { $accountAuth } from '@/store/account-auth'
import { $activeConnectionId } from '@/store/connections'
import { $activeGatewayProfile } from '@/store/profile'
import { $connection } from '@/store/session'

import { connectCloudComputer } from './connection'
import { CloudComputerControls, CloudComputerToolbar, type CloudSessionProps } from './controls'
import { useCloudComputerCopy } from './copy'
import { CloudScreen } from './screen'

type CloudSession = ReturnType<typeof connectCloudComputer>

export function CloudComputerPage() {
  const account = useStore($accountAuth)
  const connectionId = useStore($activeConnectionId)
  const profile = useStore($activeGatewayProfile)
  const connection = useStore($connection)

  if (account.phase !== 'authenticated') {
    return null
  }

  return <CloudComputerOwner key={JSON.stringify([account.user?.id, connectionId, profile, connection?.baseUrl])} />
}

function CloudComputerOwner() {
  const [session, setSession] = useState<CloudSession | null>(null)
  const t = useCloudComputerCopy()

  useEffect(() => {
    const next = connectCloudComputer()
    setSession(next)
    next.start()

    return next.dispose
  }, [])

  return session ? <CloudComputerView session={session} /> : <EmptyState title={t.loading} />
}

export function CloudComputerView({ session }: CloudSessionProps) {
  const state = useStore(session.state)
  const t = useCloudComputerCopy()
  const snapshot = state.snapshot
  const computer = snapshot?.computer
  const running = computer?.state === 'running'
  const transitioning = computer?.state === 'starting' || computer?.state === 'stopping'
  const control = state.controlling && running && Boolean(state.frame) && !state.busy

  const title = computer
    ? { starting: t.starting, running: t.running, stopping: t.stopping, stopped: t.stoppedLabel, error: t.error }[
        computer.state
      ]
    : t.title

  return (
    <section aria-label={t.title} className="flex h-full min-h-0 flex-col gap-3 p-4">
      <CloudComputerToolbar session={session} />
      <p className="text-xs text-muted-foreground">{t.preview}</p>
      {state.error || computer?.error ? (
        <p className="text-xs text-destructive" role="alert">
          {state.error ?? computer?.error}
        </p>
      ) : null}
      <div className="min-h-48 flex-1 overflow-hidden">
        {state.frame && running ? (
          <CloudScreen controlling={control} frame={state.frame} label={t.screen} onAction={session.action} />
        ) : (
          <EmptyState
            title={
              !snapshot
                ? t.loading
                : !snapshot.enabled
                  ? t.unavailable
                  : computer?.state === 'stopped'
                    ? t.stopped
                    : running || transitioning
                      ? title
                      : t.empty
            }
          />
        )}
      </div>
      <CloudComputerControls session={session} />
    </section>
  )
}
