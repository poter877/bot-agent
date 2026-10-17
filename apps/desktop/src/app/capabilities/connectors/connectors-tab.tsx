import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import type { ProfileScope } from '@/hermes'
import { useI18n } from '@/i18n'
import { notifyError } from '@/store/notifications'

import { installBundledEntry } from '../mcp/install-catalog-entry'
import { useMcpServers } from '../mcp/use-mcp-servers'

import { AddServerDialog } from './add-dialog'
import { ConnectorsDirectory } from './connectors-directory'
import { claimRouteLink } from './data/deep-link'
import { joinBundledEntries, joinLocalServers } from './data/join'
import { seedLocalServers, startConnectorPersistence, storeLocalServers } from './data/persist'
import { usePluginServers } from './data/queries'
import { cardKey, deriveCards, EMPTY_CONNECTORS_FILTER, localServerName } from './derive'
import { LocalConnectorDialog } from './local-dialog'
import { RemoveServerConfirm } from './local-slots'
import { openToolsList, resetOpenedTools } from './tools-summary'
import type { ConnectorCardModel, ConnectorsFilter } from './types'

export interface ConnectorsTabProps {
  profile: ProfileScope
}

export function ConnectorsTab({ profile }: ConnectorsTabProps) {
  const { t } = useI18n()
  const copy = t.connectorsPage

  const mcp = useMcpServers({ gateway: null, profile })

  const [filter, setFilter] = useState<ConnectorsFilter>(EMPTY_CONNECTORS_FILTER)
  const [openKey, setOpenKey] = useState<null | string>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [removeServer, setRemoveServer] = useState<null | ConnectorCardModel>(null)
  const [installing, setInstalling] = useState<null | string>(null)

  const local = useMemo(
    () =>
      joinLocalServers({
        catalog: mcp.catalog,
        servers: mcp.servers,
        status: mcp.statuses,
        toolCounts: mcp.toolCounts,
        usage: mcp.usageByServer
      }),
    [mcp.catalog, mcp.servers, mcp.statuses, mcp.toolCounts, mcp.usageByServer]
  )

  const bundled = useMemo(() => joinBundledEntries(mcp.availableCatalog), [mcp.availableCatalog])

  const lastKnownServers = useMemo(() => seedLocalServers(profile), [profile])
  const pluginServers = usePluginServers(profile)

  const servers = useMemo(
    () => [...(mcp.configLoading ? lastKnownServers : local), ...pluginServers],
    [lastKnownServers, local, mcp.configLoading, pluginServers]
  )

  useEffect(() => {
    if (!mcp.configLoading) {
      storeLocalServers(profile, local)
    }
  }, [local, mcp.configLoading, profile])

  useEffect(startConnectorPersistence, [])

  useEffect(() => {
    resetOpenedTools()
  }, [profile])

  const cards = useMemo(() => deriveCards({ bundled, local: servers }), [bundled, servers])

  const openCard = useMemo(() => cards.find(card => cardKey(card) === openKey) ?? null, [cards, openKey])

  useOpenFromRoute(cards, profile, setOpenKey)

  const bundledEntry = (card: ConnectorCardModel) =>
    mcp.availableCatalog.find(candidate => candidate.name === card.ways.entryName) ?? null

  const startInstall = async (card: ConnectorCardModel, env: Record<string, string>) => {
    const entry = bundledEntry(card)

    if (!entry) {
      return
    }

    setInstalling(cardKey(card))

    try {
      await installBundledEntry(entry, env, profile)
      await mcp.onCatalogInstalled()
      setOpenKey(cardKey(card))
    } catch (error) {
      notifyError(error, t.settings.mcp.catalogInstallFailed(card.name))
    } finally {
      setInstalling(null)
    }
  }

  const runVerb = (card: ConnectorCardModel) => {
    switch (card.verb) {
      case 'authenticate':
        void mcp.authenticate(localServerName(card))

        return

      case 'install':
        if (card.ways.entryName && card.ways.needsEnv !== true) {
          void startInstall(card, {})

          return
        }

        break

      default:
        break
    }

    setOpenKey(cardKey(card))
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-4 pb-2">
      <ConnectorsDirectory
        addYourOwn={
          <Button disabled={mcp.profilePending} onClick={() => setAddOpen(true)} size="xs" variant="outline">
            {copy.add.action}
          </Button>
        }
        busyKey={installing}
        cards={cards}
        filter={filter}
        loading={(mcp.configLoading || mcp.catalogLoading) && cards.length === 0}
        onFilterChange={setFilter}
        onOpen={card => setOpenKey(cardKey(card))}
        onServerToggle={(card, next) => {
          if (card.plugin === undefined) {
            void mcp.setServerEnabled(localServerName(card), next)
          }
        }}
        onVerb={runVerb}
        selectedKey={openKey}
      />

      {openCard ? (
        <LocalConnectorDialog
          card={openCard}
          controller={mcp}
          installFields={bundledEntry(openCard)?.required_env}
          installing={installing === cardKey(openCard)}
          onClose={() => setOpenKey(null)}
          onInstall={env => void startInstall(openCard, env)}
          onRemoveServer={() => setRemoveServer(openCard)}
          profile={profile}
        />
      ) : null}

      <AddServerDialog controller={mcp} onOpenChange={setAddOpen} open={addOpen} profile={profile} />

      <RemoveServerConfirm
        card={removeServer}
        controller={mcp}
        onClose={() => setRemoveServer(null)}
        onRemoved={() => setOpenKey(null)}
      />
    </div>
  )
}

function useOpenFromRoute(
  cards: readonly ConnectorCardModel[],
  scope: ProfileScope,
  open: (key: string) => void
): void {
  const { hash, key: locationKey, pathname, search } = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    const params = new URLSearchParams(search)
    const server = params.get('server')

    if (!server) {
      return
    }

    const target = cards.find(card => card.slug === server)

    // A tab for another profile leaves the link to the page once it takes the link's scope, and of two
    // mounted pages (one docked) only one acts on it.
    if (!target || !claimRouteLink(locationKey, params, scope)) {
      return
    }

    if (params.get('tool')) {
      openToolsList(localServerName(target))
    }

    open(cardKey(target))
    params.delete('server')
    params.delete('tool')
    params.delete('profile')

    const query = params.toString()
    navigate({ hash, pathname, search: query ? `?${query}` : '' }, { replace: true })
  }, [cards, hash, locationKey, navigate, open, pathname, scope, search])
}
