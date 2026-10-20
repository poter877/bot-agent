/**
 * The video-studio page: bot-backend's drama SPA embedded as a workspace
 * page, with honest around-the-load states (loading / unreachable / editing
 * the service address). State authority: the guest owns load truth and
 * reports it up; the page owns only presentation; the service location is
 * `$dramaBaseUrl` (machine-global).
 */
import { useStore } from '@nanostores/react'
import { type FormEvent, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Loader } from '@/components/ui/loader'
import { openExternalLink } from '@/lib/external-link'

import { useDramaCopy } from './copy'
import { DramaGuest, type DramaGuestState } from './guest'
import { $dramaBaseUrl, normalizeDramaBaseUrl } from './url'

export function DramaPage() {
  const t = useDramaCopy()
  const baseUrl = useStore($dramaBaseUrl)
  const [guest, setGuest] = useState<DramaGuestState>({ error: null, loading: true })
  const [reloadKey, setReloadKey] = useState(0)
  const [editing, setEditing] = useState(false)

  const retry = () => {
    setGuest({ error: null, loading: true })
    setReloadKey(key => key + 1)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex items-center gap-2 border-b border-(--stroke-nous) px-3 py-1.5">
        <span className="text-xs font-medium">{t.title}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{baseUrl}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button onClick={() => setReloadKey(key => key + 1)} size="xs" variant="ghost">
            {t.reload}
          </Button>
          <Button onClick={() => setEditing(open => !open)} size="xs" variant="ghost">
            {t.editUrl}
          </Button>
          <Button onClick={() => openExternalLink(baseUrl)} size="xs" variant="ghost">
            {t.openExternal}
          </Button>
        </div>
      </header>
      {editing ? <DramaUrlForm onClose={() => setEditing(false)} /> : null}
      <div className="relative min-h-0 flex-1">
        <DramaGuest baseUrl={baseUrl} onState={setGuest} reloadKey={reloadKey} />
        {guest.error ? (
          <div className="absolute inset-0 grid place-items-center bg-background p-6">
            <ErrorState
              className="w-full max-w-sm"
              description={
                <>
                  <div>{t.unreachableDescription}</div>
                  {guest.error.description || guest.error.url ? (
                    <div className="mt-1 font-mono text-[0.6875rem] break-all text-muted-foreground/70">
                      {guest.error.description || guest.error.url}
                    </div>
                  ) : null}
                </>
              }
              title={t.unreachableTitle}
            >
              <div className="flex items-center justify-center gap-2">
                <Button onClick={retry} size="sm">
                  {t.retry}
                </Button>
                <Button onClick={() => openExternalLink(baseUrl)} size="sm" variant="ghost">
                  {t.openExternal}
                </Button>
              </div>
            </ErrorState>
          </div>
        ) : guest.loading ? (
          <div className="absolute inset-0 grid place-items-center bg-background">
            <Loader label={t.loading} />
          </div>
        ) : null}
      </div>
    </div>
  )
}

function DramaUrlForm({ onClose }: { onClose: () => void }) {
  const t = useDramaCopy()
  const [value, setValue] = useState($dramaBaseUrl.get())
  const [invalid, setInvalid] = useState(false)

  const submit = (event: FormEvent) => {
    event.preventDefault()

    const origin = normalizeDramaBaseUrl(value)

    if (!origin) {
      setInvalid(true)

      return
    }

    $dramaBaseUrl.set(origin)
    onClose()
  }

  return (
    <form className="flex items-center gap-2 border-b border-(--stroke-nous) px-3 py-1.5" onSubmit={submit}>
      <label className="text-xs text-muted-foreground" htmlFor="drama-base-url">
        {t.urlLabel}
      </label>
      <Input
        aria-invalid={invalid || undefined}
        className="h-7 max-w-xs font-mono text-xs"
        id="drama-base-url"
        onChange={event => {
          setValue(event.target.value)
          setInvalid(false)
        }}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
          }
        }}
        placeholder="http://localhost:30172"
        value={value}
      />
      {invalid ? <span className="text-xs text-destructive">{t.invalidUrl}</span> : null}
      <div className="ml-auto flex items-center gap-1">
        <Button onClick={onClose} size="xs" type="button" variant="ghost">
          {t.cancel}
        </Button>
        <Button size="xs" type="submit">
          {t.save}
        </Button>
      </div>
    </form>
  )
}
