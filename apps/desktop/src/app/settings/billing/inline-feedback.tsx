import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { ExternalLink } from '@/lib/icons'

import type { BillingRefusal } from './api'
import { resolveRefusal } from './errors'

export function BillingRefusalInline({ refusal }: { refusal: BillingRefusal | null }) {
  const { t } = useI18n()

  if (!refusal) {
    return null
  }

  const resolved = resolveRefusal(refusal, t.settings.billing.errors)
  const portalUrl = resolved.action.type === 'portal' ? resolved.action.url : undefined

  return (
    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
      <span>
        <span className="font-medium text-foreground">{resolved.title}:</span> {resolved.message}
      </span>
      {portalUrl && (
        <Button onClick={() => openExternalLink(portalUrl)} size="sm" type="button" variant="outline">
          {t.settings.billing.buyCredits.openPortal}
          <ExternalLink className="size-3.5" />
        </Button>
      )}
    </div>
  )
}
