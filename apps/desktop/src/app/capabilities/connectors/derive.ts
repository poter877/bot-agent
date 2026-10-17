import { connectorTitle } from '@/lib/connector-tools'

import type {
  BundledEntryInput,
  ConnectorCardModel,
  ConnectorFact,
  ConnectorReason,
  ConnectorsFilter,
  ConnectorState,
  ConnectorStateWord,
  ConnectorWayLocal,
  LocalServerInput,
  LocalServerStatus
} from './types'

export const EMPTY_CONNECTORS_FILTER: ConnectorsFilter = { query: '', segment: 'all' }

type ConnectorVerb = 'authenticate' | 'install' | 'openLogs'

interface Phase {
  reason: ConnectorReason['key'] | undefined
  state: ConnectorState
  verb: ConnectorVerb | undefined
}

const LOCAL_PHASES = {
  error: { reason: 'serverError', state: 'broken', verb: 'openLogs' },
  'needs-auth': { reason: 'serverNeedsAuth', state: 'broken', verb: 'authenticate' },
  off: { reason: undefined, state: 'off', verb: undefined },
  ok: { reason: undefined, state: 'connected', verb: undefined },
  probing: { reason: undefined, state: 'connecting', verb: undefined },
  unknown: { reason: undefined, state: 'connecting', verb: undefined }
} satisfies Record<LocalServerStatus, Phase>

const LOCAL_WORDS = {
  available: 'available',
  broken: 'serverError',
  connected: 'serverOn',
  connecting: 'serverConnecting',
  off: 'serverOff',
  unknown: 'serverConnecting'
} satisfies Record<ConnectorState, ConnectorStateWord>

function localFact(server: LocalServerInput, state: ConnectorState): ConnectorFact | undefined {
  if (state !== 'connected' || server.unused === true || server.toolsTotal === undefined) {
    return undefined
  }

  if (server.toolsOn === undefined) {
    return { count: server.toolsTotal, key: 'tools' }
  }

  return server.toolsOn < server.toolsTotal
    ? { count: server.toolsTotal, key: 'toolsSomeOn', on: server.toolsOn }
    : { count: server.toolsOn, key: 'toolsOn' }
}

export function localWay(server: LocalServerInput): ConnectorWayLocal {
  const status: LocalServerStatus = server.enabled ? server.status : 'off'
  const phase = LOCAL_PHASES[status]

  return {
    fact: localFact(server, phase.state),
    inCatalog: server.inCatalog,
    installed: true,
    plugin: server.plugin,
    reason: phase.reason ? { key: phase.reason } : undefined,
    serverEnabled: server.enabled,
    serverName: server.name,
    state: phase.state,
    target: server.target,
    unused: server.unused,
    verb: phase.verb === 'authenticate' && server.canAuthenticate === false ? 'openLogs' : phase.verb
  }
}

export function bundledWay(entry: BundledEntryInput): ConnectorWayLocal {
  return {
    authType: entry.authType,
    entryName: entry.name,
    inCatalog: true,
    installed: false,
    needsEnv: entry.needsEnv,
    state: 'available',
    verb: 'install'
  }
}

export function localWord(way: ConnectorWayLocal): ConnectorStateWord {
  if (way.reason?.key === 'serverNeedsAuth') {
    return 'serverNeedsAuth'
  }

  return way.state === 'connected' && way.unused === true ? 'serverOnUnused' : LOCAL_WORDS[way.state]
}

export function mergeCard(input: {
  description?: string
  name: string
  slug: string
  way: ConnectorWayLocal
}): ConnectorCardModel {
  const { description, name, slug, way } = input

  return {
    description,
    fact: way.fact,
    inCatalog: way.inCatalog === true,
    name,
    plugin: way.plugin,
    reason: way.reason,
    slug,
    state: way.state,
    stateWord: localWord(way),
    verb: way.verb,
    ways: way
  }
}

export function localServerName(card: ConnectorCardModel): string {
  return card.ways.serverName ?? card.slug
}

export interface DeriveCardsInput {
  bundled?: readonly BundledEntryInput[]
  local: readonly LocalServerInput[]
  titles?: Readonly<Record<string, string>>
}

interface CardParts {
  bundled?: BundledEntryInput
  local?: LocalServerInput
}

export const localCardKey = (name: string) => `local:${name}`

export const cardKey = (card: ConnectorCardModel): string => localCardKey(card.slug)

const mergeKey = (connectorSlug: string | undefined, name: string) => connectorSlug ?? localCardKey(name)

// An install must not rename the app: the bundled entry and the server it becomes read the same way.
function nameOf({ bundled, local }: CardParts, titles: Readonly<Record<string, string>>, slug: string): string {
  const key = local?.connectorSlug ?? bundled?.connectorSlug ?? slug

  return titles[key] ?? local?.title ?? connectorTitle(local?.name ?? bundled?.name ?? slug)
}

function cardOf(slot: CardParts, titles: Readonly<Record<string, string>>): ConnectorCardModel | null {
  const way = slot.local ? localWay(slot.local) : slot.bundled ? bundledWay(slot.bundled) : null

  if (!way) {
    return null
  }

  const slug = slot.local?.name ?? slot.bundled?.name ?? ''

  return mergeCard({
    description: slot.local?.description ?? slot.bundled?.description,
    name: nameOf(slot, titles, slug),
    slug,
    way
  })
}

export function deriveCards({ bundled = [], local, titles = {} }: DeriveCardsInput): ConnectorCardModel[] {
  const parts = new Map<string, CardParts>()

  for (const server of local) {
    slotAt(parts, mergeKey(server.connectorSlug, server.name)).local = server
  }

  for (const entry of bundled) {
    const slot = slotAt(parts, mergeKey(entry.connectorSlug, entry.name))

    // An installed server always beats the bundled entry of the same app.
    if (!slot.local) {
      slot.bundled = entry
    }
  }

  const cards: ConnectorCardModel[] = []

  for (const slot of parts.values()) {
    const card = cardOf(slot, titles)

    if (card) {
      cards.push(card)
    }
  }

  return cards
}

function slotAt(parts: Map<string, CardParts>, key: string): CardParts {
  const found = parts.get(key)

  if (found) {
    return found
  }

  const fresh: CardParts = {}
  parts.set(key, fresh)

  return fresh
}
