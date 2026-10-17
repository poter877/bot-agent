'use client'

import { type ToolCallMessagePartProps } from '@assistant-ui/react'
import { useMemo } from 'react'

import { ToolFallback } from '@/components/assistant-ui/tool/fallback'
import { WIDGET_SHELL_CLASS } from '@/components/chat/widget-shell'
import { ConnectorSummary } from '@/components/ui/connector-card'
import { useI18n } from '@/i18n'
import { type McpTarget, mcpTargets } from '@/lib/connector-tools'
import { Loader2 } from '@/lib/icons'
import { prettyName } from '@/lib/text'
import { cn } from '@/lib/utils'

import { parseMaybeObject } from './tool/fallback-model/format'

type SetupAction = McpTarget['action']
type SetupCopy = ReturnType<typeof useI18n>['t']['assistant']['mcpSetup']

const SHELL_CLASS = `${WIDGET_SHELL_CLASS} text-[length:var(--conversation-text-font-size)] text-(--ui-text-primary)`

const TITLE = {
  authorize: (copy: SetupCopy) => copy.authorizeTitle,
  enable: (copy: SetupCopy) => copy.enableTitle,
  install: (copy: SetupCopy) => copy.installTitle
} satisfies Record<SetupAction, (copy: SetupCopy) => string>

const DONE = {
  authorize: (copy: SetupCopy, server: string) => copy.authorized(server),
  enable: (copy: SetupCopy, server: string) => copy.enabled(server),
  install: (copy: SetupCopy, server: string) => copy.installed(server)
} satisfies Record<SetupAction, (copy: SetupCopy, server: string) => string>

interface SettledTarget {
  name: string
  state: string
  tools: number
  toolsUnavailable: boolean
}

/** A settled operation is a static per-target summary: one word per row, no controls. */
function McpSetupSummary({ action, rows }: { action: SetupAction; rows: SettledTarget[] }) {
  const { t } = useI18n()
  const copy = t.assistant.mcpSetup

  return (
    <div className="my-2 grid min-w-0 max-w-lg gap-1" data-connector-offer>
      {rows.map(row => {
        const title = prettyName(row.name)
        const connected = row.state === 'connected'

        const line = connected
          ? row.toolsUnavailable
            ? `${DONE[action](copy, title)} · ${t.connectors.authorizedToolsUnavailable}`
            : DONE[action](copy, title)
          : row.state === 'skipped'
            ? t.connectors.skipped
            : t.connectors.notConnected

        return (
          <ConnectorSummary
            connector={{ name: row.name, title }}
            key={row.name}
            meta={connected && row.tools > 0 ? `${line} · ${copy.toolCount(row.tools)}` : line}
            tone={connected ? 'ok' : undefined}
          />
        )
      })}
    </div>
  )
}

function readSetupAction(args: unknown): SetupAction {
  const [target] = mcpTargets('manage_connections', parseMaybeObject(args))

  return target?.action ?? 'install'
}

function readSetupResult(result: unknown): SettledTarget[] {
  const row = parseMaybeObject(result)
  const targets = Array.isArray(row.targets) ? row.targets.map(parseMaybeObject) : []

  return targets.flatMap(target => {
    const name = typeof target.name === 'string' ? target.name.trim().toLowerCase() : ''

    return name
      ? [
          {
            name,
            state: typeof target.state === 'string' ? target.state : '',
            tools: Array.isArray(target.tools) ? target.tools.length : 0,
            toolsUnavailable: Boolean(target.discovery_error)
          }
        ]
      : []
  })
}

/** A `manage_connections` call. The live consent card rode `connection.request`/`connection.respond`,
 *  which the gateway no longer speaks; the row renders the settled per-server summary from the call's
 *  own result (every real row is history — a running call just shows its title until it settles). */
export const McpSetupTool = (props: ToolCallMessagePartProps) => {
  const { t } = useI18n()
  const action = useMemo(() => readSetupAction(props.args), [props.args])

  if (props.result === undefined) {
    return (
      <div className={cn(SHELL_CLASS, 'my-1.5 flex items-center gap-2')} data-slot="connector-card">
        <Loader2 aria-hidden className="size-4 animate-spin text-(--ui-text-tertiary)" />
        <span className="text-(--ui-text-tertiary)">{TITLE[action](t.assistant.mcpSetup)}</span>
      </div>
    )
  }

  if (props.isError) {
    return <ToolFallback {...props} />
  }

  return <McpSetupSummary action={action} rows={readSetupResult(props.result)} />
}
