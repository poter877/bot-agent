import { createClient, type RedisClientType } from 'redis'

export interface RedisConnections {
  /** Commands (rate limiting, health probe). */
  commands: RedisClientType
  /** Pub/sub subscriber for cross-instance revocation notifications. */
  subscriber: RedisClientType
}

/** Max boot wait for the initial connection; after that we stop blocking. */
const CONNECT_WAIT_MS = 4000

async function connectInBackground(client: RedisClientType): Promise<void> {
  const attempt = client.connect()
  // Reconnect-loop failures surface here; keep them silent (commands reject
  // on their own and map to 503 at the call sites).
  attempt.catch(() => {})
  // While the dependency is down, node-redis keeps the connect promise pending
  // inside its reconnect loop — bound the boot wait instead of blocking
  // startup forever. Dependent paths answer 503 until it is ready.
  await Promise.race([
    attempt,
    new Promise<void>((resolve) => setTimeout(resolve, CONNECT_WAIT_MS).unref()),
  ])
}

export async function createRedisConnections(url: string): Promise<RedisConnections> {
  const options = {
    url,
    // Commands reject immediately while offline: the API answers 503 instead
    // of queueing traffic against a dead dependency (fail-closed).
    disableOfflineQueue: true,
    connectTimeout: 3000,
  }
  const commands = createClient(options)
  const subscriber = createClient(options)
  // node-redis requires an 'error' listener; real command failures reject
  // their own promises and surface as 503s at the call sites.
  commands.on('error', () => {})
  subscriber.on('error', () => {})
  await Promise.all([connectInBackground(commands), connectInBackground(subscriber)])
  return { commands, subscriber }
}

export async function closeRedisConnections(connections: RedisConnections): Promise<void> {
  // quit() never resolves while a client is offline (no socket to send on):
  // bound the graceful attempt, then force-close.
  const close = async (client: RedisClientType): Promise<void> => {
    const quit = client.quit()
    quit.catch(() => {})
    await Promise.race([quit, new Promise((resolve) => setTimeout(resolve, 1500).unref())])
    if (!client.isReady) {
      client.disconnect()
    }
  }
  await Promise.allSettled([close(connections.commands), close(connections.subscriber)])
}
