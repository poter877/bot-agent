import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { useMemo, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { ToolFallback } from '@/components/assistant-ui/tool/fallback'
import { sessionOwnerFor } from '@/components/assistant-ui/use-connection-owner'
import { WIDGET_SHELL_CLASS } from '@/components/chat/widget-shell'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useI18n } from '@/i18n'
import type { CatalogInstallTranslations, InstallPhase } from '@/i18n/types_catalog_install'
import { Book, Loader2, Plug } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { type AgentPluginInstallResult, installAgentPlugin } from '@/store/agent-plugins'
import { requestGatewayForAgent } from '@/store/gateway'
import { notifyError } from '@/store/notifications'
import { profileLabel } from '@/store/profile'

import { parseMaybeObject } from './tool/fallback-model/format'

type CatalogCopy = CatalogInstallTranslations

const SHELL_CLASS = `${WIDGET_SHELL_CLASS} text-[length:var(--conversation-text-font-size)] text-(--ui-text-primary)`
const CAPTION = 'text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height)'
const PILL = 'inline-flex items-center rounded-full px-1.5 py-0.5 text-[0.62rem] font-medium leading-[0.93rem]'

const KIND_GLYPH = { plugin: Plug, skill: Book } as const

const TIERS = ['official', 'community'] as const
const PHASES: readonly InstallPhase[] = ['downloading', 'python_packages', 'loading_tools']

function platformName(platform: string): string {
  switch (platform.toLowerCase()) {
    case 'darwin':

    case 'macos':
      return 'macOS'

    case 'linux':
      return 'Linux'

    case 'windows':
      return 'Windows'

    default:
      return platform
  }
}

/** One catalog row as the settled result carries it (`tools_mcp_plugins` catalog row contract). The
 *  backend resolved the model's id; every word on a row is the backend's answer. */
interface CatalogTarget {
  alreadyInstalled: boolean
  approved: { enable: boolean; force: boolean; ref: null | string } | null
  description: string
  detail: string
  display: string
  enabled: null | boolean
  kind: 'plugin' | 'skill'
  missingEnv: string[]
  name: string
  phase: InstallPhase | null
  platforms: string[]
  resolved: boolean
  serverErrors: { error: string; name: string }[]
  skill: null | string
  state: string
  targetProfile: null | string
  tier: (typeof TIERS)[number] | null
  tools: string[]
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(entry => (typeof entry === 'string' && entry ? [entry] : [])) : []

/** Parse one settled row of a `manage_catalog` result. Rows the backend did not name are dropped. */
function parseCatalogTarget(raw: unknown): CatalogTarget | null {
  const row = parseMaybeObject(raw)
  const name = text(row.name).trim()

  if (!name) {
    return null
  }

  const approvedRaw = parseMaybeObject(row.approved)

  return {
    alreadyInstalled: row.already_installed === true,
    approved:
      approvedRaw.force === undefined && approvedRaw.enable === undefined
        ? null
        : {
            enable: approvedRaw.enable === true,
            force: approvedRaw.force === true,
            ref: typeof approvedRaw.ref === 'string' ? approvedRaw.ref : null
          },
    description: text(row.description),
    detail: text(row.detail),
    display: text(row.display).trim() || name,
    enabled: typeof row.enabled === 'boolean' ? row.enabled : null,
    kind: text(row.kind) === 'skill' ? 'skill' : 'plugin',
    missingEnv: strings(row.missing_env),
    name,
    phase: PHASES.find(candidate => candidate === row.phase) ?? null,
    platforms: strings(row.platforms),
    resolved: row.resolved === true,
    serverErrors: (Array.isArray(row.server_errors) ? row.server_errors : []).flatMap(entry => {
      const error = parseMaybeObject(entry)

      return text(error.name) || text(error.error) ? [{ error: text(error.error), name: text(error.name) }] : []
    }),
    skill: text(row.skill) || null,
    state: text(row.state) || 'pending',
    targetProfile: text(row.target_profile).trim() || null,
    tier: TIERS.find(candidate => candidate === row.tier) ?? null,
    tools: strings(row.tools)
  }
}

function readCatalogTargets(result: unknown): CatalogTarget[] {
  const row = parseMaybeObject(result)
  const targets = Array.isArray(row.targets) ? row.targets : []

  return targets.flatMap(target => {
    const parsed = parseCatalogTarget(target)

    return parsed ? [parsed] : []
  })
}

/** `manage_catalog`: the host's catalog-install rows, drawn from the call's own settled result. The
 *  live consent card rode `connection.request`/`connection.respond`, which the gateway no longer
 *  speaks — the approval flow covers that today, and this renders the operation's outcome. */
export function CatalogInstallTool(props: ToolCallMessagePartProps) {
  const { t } = useI18n()
  const view = useSessionView()
  const runtimeId = useStore(view.$runtimeId)

  const rows = useMemo(() => (props.result === undefined ? [] : readCatalogTargets(props.result)), [props.result])

  if (props.result !== undefined && !props.isError && rows.length > 0) {
    return <CatalogInstallCard rows={rows} runtimeId={runtimeId} />
  }

  // While the call runs, consent rides the approval card; a finished call with no parsable rows is
  // plain history and takes the generic row.
  if (props.result !== undefined || props.status?.type !== 'running') {
    return <ToolFallback {...props} />
  }

  return (
    <div className={cn(SHELL_CLASS, 'my-1.5 flex max-w-lg items-center gap-2')} data-catalog-card>
      <Loader2 aria-hidden className="size-4 animate-spin text-(--ui-text-tertiary) motion-reduce:animate-none" />
      <span className="text-(--ui-text-tertiary)">{t.assistant.catalogInstall.preparing}</span>
    </div>
  )
}

function CatalogInstallCard({ rows, runtimeId }: { rows: CatalogTarget[]; runtimeId: null | string }) {
  const { t } = useI18n()
  const profile = rows[0]?.targetProfile

  return (
    <div className="my-2 grid min-w-0 max-w-lg gap-4.5" data-catalog-card>
      {rows.map(target => (
        <CatalogRow key={target.name} runtimeId={runtimeId} target={target} />
      ))}
      {profile ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 px-3.5">
          <span className={cn(CAPTION, 'text-(--ui-text-tertiary)')}>
            {t.assistant.catalogInstall.targetProfile(profileLabel({ name: profile }))}
          </span>
        </div>
      ) : null}
    </div>
  )
}

interface CatalogRowProps {
  runtimeId: null | string
  target: CatalogTarget
}

/** One catalog item: what it is, and what happened to it. */
function CatalogRow({ runtimeId, target: initialTarget }: CatalogRowProps) {
  const { t } = useI18n()
  const copy = t.assistant.catalogInstall
  // Try again on a failed plugin row redraws the row with the fresh install's result.
  const [target, setTarget] = useState(initialTarget)
  const [retrying, setRetrying] = useState(false)
  const Glyph = KIND_GLYPH[target.kind]

  const retry = () => {
    if (runtimeId === null) {
      return
    }

    setRetrying(true)

    sessionOwnerFor(runtimeId, 'plugins.manage')
      .then(async owner => {
        if (!owner) {
          setTarget(current => ({ ...current, detail: copy.sendFailed }))

          return
        }

        const result = await installAgentPlugin(
          (method, params, timeoutMs) =>
            requestGatewayForAgent(owner.connectionId, owner.profile, method, params, timeoutMs),
          {
            catalogName: target.name,
            enable: target.approved?.enable,
            force: target.approved?.force,
            identifier: '',
            profile: target.targetProfile,
            ref: target.approved?.ref ?? undefined
          }
        )

        if (result.ok) {
          setTarget(current => installedRow(current, result))
        } else {
          setTarget(current => ({ ...current, detail: result.error || current.detail }))
        }
      })
      .catch(error => notifyError(error, copy.sendFailed))
      .finally(() => setRetrying(false))
  }

  return (
    <div className={cn(SHELL_CLASS, 'grid min-w-0 gap-1.5')} data-connector-row={target.name} tabIndex={-1}>
      <div className="flex min-w-0 items-start gap-3">
        <span
          aria-hidden
          className="grid size-10 shrink-0 place-items-center rounded-xl bg-(--ui-bg-quaternary) text-(--ui-text-secondary)"
        >
          <Glyph className="size-5" stroke={1.75} />
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1">
            <span className="font-medium leading-4.5 wrap-anywhere">{target.display}</span>
            <span className={cn(PILL, 'bg-(--ui-bg-quaternary) text-muted-foreground')}>{copy.kind[target.kind]}</span>
            {target.tier ? (
              <span className={cn(PILL, 'bg-(--ui-bg-quaternary) text-muted-foreground')}>{copy.tier[target.tier]}</span>
            ) : null}
            {target.platforms.map(platform => (
              <span className={cn(PILL, 'bg-primary/8 text-primary')} key={platform}>
                {platformName(platform)}
              </span>
            ))}
          </div>
          {target.description ? (
            <p className="leading-4.5 text-(--ui-text-secondary) wrap-anywhere">{target.description}</p>
          ) : null}
        </div>
      </div>

      <div className="min-w-0 pl-13">
        <RowOutcome
          copy={copy}
          onRetry={target.kind === 'plugin' ? retry : undefined}
          retrying={retrying}
          retryLabel={t.connectors.retry}
          skippedLabel={t.connectors.skipped}
          target={target}
          toolCount={t.assistant.mcpSetup.toolCount}
        />
      </div>
    </div>
  )
}

/** What an installed row still needs, worded from the backend's facts. */
function installedNotes(catalog: CatalogTarget, copy: CatalogCopy): string[] {
  return [
    ...catalog.serverErrors.map(({ error, name }) => copy.serverNotConnected(name, error)),
    ...(catalog.enabled === false ? [copy.notEnabled] : []),
    ...(catalog.missingEnv.length > 0 ? [copy.missingEnv(catalog.missingEnv.join(', '))] : []),
    ...(catalog.alreadyInstalled ? [copy.alreadyInstalled] : [])
  ]
}

/** The row a successful retry draws: the install's result, in the fields the settled row carries. */
function installedRow(previous: CatalogTarget, result: AgentPluginInstallResult): CatalogTarget {
  const servers = result.live.mcpServers

  return {
    ...previous,
    alreadyInstalled: false,
    detail: '',
    enabled: result.enabled ?? null,
    missingEnv: result.missingEnv ?? [],
    serverErrors: servers
      .filter(server => !server.connected)
      .map(({ error, name }) => ({ error: error ?? '', name })),
    skill: result.skillIds?.[0] ?? null,
    state: 'connected',
    tools: servers.filter(server => server.connected).flatMap(server => server.tools)
  }
}

/** Try again on a failed plugin row draws a fresh host install's result; the state lives on the row. */

/** The third line: what happened to the row. */
function RowOutcome({
  copy,
  onRetry,
  retrying,
  retryLabel,
  skippedLabel,
  target,
  toolCount
}: {
  copy: CatalogCopy
  onRetry?: () => void
  retrying: boolean
  retryLabel: string
  skippedLabel: string
  target: CatalogTarget
  toolCount: (count: number) => string
}) {
  const [namesOpen, setNamesOpen] = useState(false)

  if (target.state === 'connected') {
    const parts = [
      copy.installed,
      target.tools.length > 0 ? toolCount(target.tools.length) : '',
      target.skill ? copy.skill(target.skill) : ''
    ]

    const notes = installedNotes(target, copy)

    return (
      <div className="grid min-w-0 gap-1">
        <p className={cn(CAPTION, 'text-emerald-600 dark:text-emerald-400')} role="status">
          {parts.filter(Boolean).join(' · ')}
          {target.tools.length > 0 ? (
            <>
              {' · '}
              <button
                aria-expanded={namesOpen}
                className="underline-offset-2 hover:underline"
                onClick={() => setNamesOpen(open => !open)}
                type="button"
              >
                {namesOpen ? copy.hideNames : copy.showNames}
              </button>
            </>
          ) : null}
        </p>
        {notes.length > 0 ? (
          <p className={cn(CAPTION, 'text-(--ui-text-tertiary) wrap-anywhere')}>{notes.join(' · ')}</p>
        ) : null}
        {namesOpen ? (
          <ul className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 font-mono text-[0.6875rem] leading-4 text-(--ui-text-secondary)">
            {target.tools.map(tool => (
              <li className="min-w-0 break-all" key={tool}>
                {tool}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    )
  }

  if (target.state === 'failed' || target.state === 'expired') {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
        <p className={cn(CAPTION, 'min-w-0 text-destructive wrap-anywhere')} role="status">
          {target.detail ? `${copy.failed} · ${target.detail}` : copy.failed}
        </p>
        {target.kind === 'plugin' && onRetry ? (
          <Button
            className="h-6 px-1.5 text-(--ui-text-tertiary)"
            disabled={retrying}
            loading={retrying}
            onClick={onRetry}
            size="xs"
            variant="ghost"
          >
            {retryLabel}
          </Button>
        ) : null}
      </div>
    )
  }

  if (target.state === 'skipped') {
    return (
      <p className={cn(CAPTION, 'text-(--ui-text-tertiary)')} role="status">
        {skippedLabel}
      </p>
    )
  }

  if (target.state === 'initiated' && target.phase) {
    return (
      <div className="grid min-w-0 gap-1.5" role="status">
        <p className={cn(CAPTION, 'text-(--ui-text-tertiary)')}>{copy.installing}</p>
        <Progress animated aria-label={copy.installing} className="h-0.5 bg-primary/15" indeterminate />
        <p className={cn(CAPTION, 'text-(--ui-text-quaternary)')}>{copy.phase[target.phase]}</p>
      </div>
    )
  }

  return (
    <p className={cn(CAPTION, 'text-(--ui-text-tertiary)')} role="status">
      {copy.notInstalled}
    </p>
  )
}
