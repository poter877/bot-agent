import { PanelEmpty } from '@/app/overlays/panel'
import { useI18n } from '@/i18n'

import type { ToolsEditorPhase } from './types'

export function ToolsWash({ label, rows = 8 }: { label?: string; rows?: number }) {
  const { t } = useI18n()

  return (
    <div aria-busy className="grid gap-2 px-3.5 py-3" role="status">
      <span className="sr-only">{label ?? t.connectorsPage.tools.loading}</span>
      {Array.from({ length: rows }, (_, index) => (
        <span
          aria-hidden
          className="h-3 rounded-sm bg-(--ui-bg-quaternary)"
          key={index}
          style={{ width: `${68 - (index % 4) * 9}%` }}
        />
      ))}
    </div>
  )
}

export type ToolsStatusPhase = 'needsAuth' | 'off'

const ICON = {
  needsAuth: 'key',
  off: 'plug'
} satisfies Record<ToolsStatusPhase, string>

export function isToolsStatusPhase(phase: ToolsEditorPhase): phase is ToolsStatusPhase {
  return phase === 'needsAuth' || phase === 'off'
}

export function ToolsStatus({ connectorName, phase }: { connectorName: string; phase: ToolsStatusPhase }) {
  const { t } = useI18n()
  const copy = t.connectorsPage.tools

  return (
    <PanelEmpty
      description={phase === 'needsAuth' ? copy.needsAuthBody : copy.offBody}
      icon={ICON[phase]}
      title={phase === 'needsAuth' ? copy.needsAuthTitle(connectorName) : copy.offTitle(connectorName)}
    />
  )
}
