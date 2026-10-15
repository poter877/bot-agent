import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { ErrorIcon } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import {
  cancelOnboardingFlow,
  type OnboardingContext,
  type OnboardingFlow,
  refreshOnboarding,
  startManualOnboarding,
  startProviderOAuth
} from '@/store/onboarding'

export function OnboardingErrorPanel({
  ctx,
  flow
}: {
  ctx: OnboardingContext
  flow: Extract<OnboardingFlow, { status: 'error' }>
}) {
  const { t } = useI18n()
  const [retrying, setRetrying] = useState(false)
  const retryCompany = async () => {
    setRetrying(true)
    try {
      await refreshOnboarding(ctx)
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className="grid gap-3" role="alert">
      <div className="flex items-center gap-1.5 text-sm text-destructive">
        <ErrorIcon className="shrink-0" size="0.875rem" />
        <span>{flow.managed ? t.onboarding.companyUnavailable : flow.message || t.onboarding.signInFailed}</span>
      </div>
      {flow.detail ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">{t.onboarding.errorDetails}</summary>
          <pre className="mt-1 whitespace-pre-wrap wrap-break-word font-mono text-[0.6875rem]">{flow.detail}</pre>
        </details>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        {flow.managed ? (
          <Button disabled={retrying} onClick={() => void retryCompany()}>
            {t.onboarding.tryAgain}
          </Button>
        ) : (
          <>
            <Button onClick={cancelOnboardingFlow} variant="text">
              {t.onboarding.pickDifferentProvider}
            </Button>
            <Button onClick={() => startManualOnboarding(null, ctx.scope ?? ctx.profile)} variant="outline">
              {t.onboarding.useApiKeyInstead}
            </Button>
            {flow.provider ? (
              <Button onClick={() => void startProviderOAuth(flow.provider!, ctx)}>{t.onboarding.tryAgain}</Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
