import { serve } from '@hono/node-server'
import { loadConfig } from './config/env.js'
import { createLogger } from './shared/logger.js'
import { closeDatabase, createDatabase } from './db/client.js'
import { closeRedisConnections, createRedisConnections } from './redis/client.js'
import { subscribeRevocations } from './redis/events.js'
import { createMailTransport, OutboxWorker } from './modules/mail/mail.service.js'
import { createApp } from './app.js'

/**
 * Boot sequence: validate config (fail fast, no default secrets) -> open
 * PostgreSQL and Redis -> build the app -> listen -> start the mail outbox
 * worker. Shutdown stops intake, drains in-flight requests within the
 * graceful budget, then closes worker, Redis, and the database pool in order.
 */

const config = loadConfig()
const logger = createLogger(config)

const database = createDatabase({
  connectionString: config.DATABASE_URL,
  statementTimeoutMs: config.REQUEST_TIMEOUT_MS,
})
const redis = await createRedisConnections(config.REDIS_URL)

const mailWorker = new OutboxWorker(database.db, createMailTransport(config, logger), config, logger)

const { hono } = await createApp({ config, database, redis, logger })

await subscribeRevocations(redis.subscriber, (event) => {
  // Message-phase connection managers will consume these to drop live
  // connections; today peer instances re-verify state against PostgreSQL.
  logger.info({ ...event }, 'auth_revocation_event')
})

const server = serve({ fetch: hono.fetch, port: config.PORT }, (info) => {
  logger.info({ port: info.port, env: config.NODE_ENV }, 'listening')
})

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'shutdown_started')
  const drained = new Promise<void>((resolve) => server.close(() => resolve()))
  const budgetExhausted = new Promise<void>((resolve) => setTimeout(resolve, config.SERVER_GRACEFUL_TIMEOUT_MS).unref())
  await Promise.race([drained, budgetExhausted])
  await mailWorker.stop()
  await closeRedisConnections(redis)
  await closeDatabase(database)
  logger.info('shutdown_complete')
  process.exit(0)
}

process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled_rejection')
  process.exit(1)
})
