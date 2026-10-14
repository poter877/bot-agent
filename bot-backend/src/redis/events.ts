import type { RedisClientType } from 'redis'

/**
 * Cross-instance session/account revocation notifications. The database stays
 * the authoritative source (every request re-checks server-side state); this
 * channel exists so peer instances can evict caches and drop long-lived
 * connections the moment a revocation happens, instead of waiting for TTLs.
 */

export const REVOCATION_CHANNEL = 'bot-backend:auth:revocations'

export interface RevocationEvent {
  type: 'session_revoked' | 'family_revoked' | 'account_disabled' | 'password_reset'
  userId: string
  sessionId?: string
  familyId?: string
  requestId?: string
}

export async function publishRevocation(redis: RedisClientType, event: RevocationEvent): Promise<void> {
  await redis.publish(REVOCATION_CHANNEL, JSON.stringify(event))
}

export async function subscribeRevocations(
  subscriber: RedisClientType,
  handler: (event: RevocationEvent) => void,
): Promise<void> {
  await subscriber.subscribe(REVOCATION_CHANNEL, (message) => {
    try {
      handler(JSON.parse(message) as RevocationEvent)
    } catch {
      // A malformed event must not kill the subscriber loop; peer instances
      // re-verify state against the database regardless.
    }
  })
}
