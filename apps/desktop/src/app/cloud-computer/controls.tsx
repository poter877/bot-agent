import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'

import type { connectCloudComputer } from './connection'
import { useCloudComputerCopy } from './copy'

export interface CloudSessionProps {
  session: ReturnType<typeof connectCloudComputer>
}

export function CloudComputerToolbar({ session }: CloudSessionProps) {
  const state = useStore(session.state)
  const t = useCloudComputerCopy()
  const snapshot = state.snapshot
  const computer = snapshot?.computer
  const running = computer?.state === 'running'
  const transitioning = computer?.state === 'starting' || computer?.state === 'stopping'

  const title = computer
    ? { starting: t.starting, running: t.running, stopping: t.stopping, stopped: t.stoppedLabel, error: t.error }[
        computer.state
      ]
    : t.title

  const controlLabel = state.controlling
    ? t.youControl
    : snapshot?.lease.holder === 'human'
      ? t.otherControls
      : t.watching

  return (
    <header className="flex flex-wrap items-center gap-2">
      <h1 className="text-sm font-medium">{t.title}</h1>
      <span className="text-xs text-muted-foreground" role="status">
        {title}
      </span>
      <span className="grow" />
      {snapshot?.enabled && !running ? (
        <Button
          disabled={state.busy || transitioning}
          onClick={() => {
            void session.launch()
          }}
          size="sm"
        >
          {computer ? t.resume : t.start}
        </Button>
      ) : null}
      {running ? (
        <>
          <span className="text-xs text-muted-foreground">{controlLabel}</span>
          <Button
            disabled={state.busy}
            onClick={() => {
              void (state.controlling ? session.release() : session.acquire())
            }}
            size="sm"
          >
            {state.controlling ? t.handBack : t.takeOver}
          </Button>
          <Button
            disabled={state.busy}
            onClick={() => {
              void session.stop()
            }}
            size="sm"
            variant="secondary"
          >
            {t.stop}
          </Button>
        </>
      ) : null}
      <Button
        disabled={state.busy}
        onClick={() => {
          void session.retry()
        }}
        size="sm"
        variant="ghost"
      >
        {t.retry}
      </Button>
    </header>
  )
}

export function CloudComputerControls({ session }: CloudSessionProps) {
  const state = useStore(session.state)
  const t = useCloudComputerCopy()
  const [text, setText] = useState('')
  const snapshot = state.snapshot
  const running = snapshot?.computer?.state === 'running'
  const control = state.controlling && running && Boolean(state.frame) && !state.busy

  return (
    <>
      {running ? (
        <>
          <p className="text-xs text-muted-foreground">{t.controlHint}</p>
          <form
            className="flex items-center gap-2"
            onSubmit={event => {
              event.preventDefault()

              if (control && text) {
                void session.action({ action: 'type', params: { text } })
                setText('')
              }
            }}
          >
            <Input
              aria-label={t.text}
              disabled={!control}
              maxLength={8000}
              onChange={event => setText(event.target.value)}
              placeholder={t.text}
              value={text}
            />
            <Button disabled={!control || !text} size="sm" type="submit">
              {t.send}
            </Button>
            {['Return', 'Tab', 'Escape', 'BackSpace'].map(key => (
              <Button
                disabled={!control}
                key={key}
                onClick={() => {
                  void session.action({ action: 'key', params: { keys: [key] } })
                }}
                size="sm"
                type="button"
                variant="secondary"
              >
                {key === 'Return' ? 'Enter' : key === 'BackSpace' ? '⌫' : key === 'Escape' ? 'Esc' : key}
              </Button>
            ))}
          </form>
        </>
      ) : null}
      {snapshot?.enabled ? (
        <div className="space-y-1 border-t border-(--ui-stroke-secondary) pt-3">
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={snapshot.agentEnabled}
              disabled={state.busy}
              onCheckedChange={checked => {
                void session.configure(checked === true)
              }}
            />
            {t.agent}
          </label>
          <p className="text-xs text-muted-foreground">{t.agentHint}</p>
        </div>
      ) : null}
    </>
  )
}
