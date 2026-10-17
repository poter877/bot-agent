import { type ProfileScope, profileScopeKey } from '@/hermes'
import { activeGatewayConnectionId } from '@/store/gateway'

/** The scope a link names: the profile, pinned to its connection when that is not the active one. */
export function linkedScope(params: URLSearchParams): null | string | { connectionId: string; profile: string } {
  const profile = params.get('profile')?.trim()

  if (!profile) {
    return null
  }

  const connectionId = params.get('connection')?.trim()

  // The active connection is the ambient route; only another connection needs a pinned scope.
  return connectionId && connectionId !== (activeGatewayConnectionId() ?? 'local') ? { connectionId, profile } : profile
}

const claimedLinks = new Set<string>()

/** Whether this mounted Connectors tab handles the link at `locationKey`. A tab for another scope waits for
 *  the page to switch to the link's scope, and of several mounted pages only the first takes it. */
export function claimRouteLink(locationKey: string, params: URLSearchParams, scope: ProfileScope): boolean {
  const linked = linkedScope(params)

  if (linked !== null && profileScopeKey(linked) !== profileScopeKey(scope)) {
    return false
  }

  const claim = `${locationKey}?${params.toString()}`

  if (claimedLinks.has(claim)) {
    return false
  }

  claimedLinks.add(claim)

  return true
}

export function resetRouteLinksForTests(): void {
  claimedLinks.clear()
}
