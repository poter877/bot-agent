import { Button } from '@/components/ui/button'
import type { ProfileScope } from '@/hermes'
import { useI18n } from '@/i18n'
import { startManualProviderOAuth } from '@/store/onboarding'

import type { HostedPhase } from './types'

export function HostedNotice({ phase, scope }: { phase: HostedPhase; scope: ProfileScope }) {
  const { t } = useI18n()
  const copy = t.connectorsPage.page

  if (phase === 'signedOut') {
    return (
      <p className="flex shrink-0 items-center gap-1 text-[0.7rem] text-(--ui-text-tertiary)">
        {copy.signInLine}
        {/* The hosted service rides the Nous account, so the sign-in is the
            provider OAuth flow the Providers page drives. */}
        <Button onClick={() => startManualProviderOAuth('nous', scope)} size="xs" variant="text">
          {copy.signIn}
        </Button>
      </p>
    )
  }

  if (phase === 'unavailable') {
    return <p className="shrink-0 text-[0.7rem] text-(--ui-text-tertiary)">{copy.managedUnavailable}</p>
  }

  return null
}
