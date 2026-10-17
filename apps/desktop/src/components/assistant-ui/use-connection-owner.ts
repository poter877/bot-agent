import { useEffect, useState } from 'react'

import { resolveSessionOwner } from '@/app/session/hooks/use-session-actions/utils'
import { $activeGatewayProfile } from '@/store/profile'
import { assertSessionOwnerResolved } from '@/store/session-owner-resolution'
import { isSessionOwnerRoute } from '@/store/session-request-router'

/** The gateway route that owns a session: which registered connection and profile its cards must
 *  talk to. Null until it resolves and null when it cannot — a card RPC must reach the gateway that
 *  holds the session, never whichever one the window happens to have in front. */
export interface SessionOwner {
  connectionId: null | string
  profile: string
}

export async function sessionOwnerFor(sessionId: string, method: string): Promise<SessionOwner | null> {
  const ambientProfile = $activeGatewayProfile.get()

  try {
    const scope = await resolveSessionOwner(sessionId)
    assertSessionOwnerResolved(scope, { method, sessionId })

    return {
      connectionId: isSessionOwnerRoute(scope) ? scope.connectionId : null,
      profile: isSessionOwnerRoute(scope) ? scope.profile : scope || ambientProfile
    }
  } catch {
    return null
  }
}

/** The session owner, resolved once the card using it becomes active. */
export function useSessionOwner(sessionId: null | string, active: boolean): SessionOwner | null {
  const [owner, setOwner] = useState<SessionOwner | null>(null)

  useEffect(() => {
    if (!sessionId || !active) {
      setOwner(null)

      return
    }

    let cancelled = false

    void sessionOwnerFor(sessionId, 'plugins.manage').then(resolved => {
      if (!cancelled) {
        setOwner(resolved)
      }
    })

    return () => {
      cancelled = true
    }
  }, [active, sessionId])

  return owner
}
