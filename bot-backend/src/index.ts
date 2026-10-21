import { serve } from '@hono/node-server'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { loadConfig } from './config/env.js'
import { createLogger } from './shared/logger.js'
import { closeDatabase, createDatabase } from './db/client.js'
import { closeRedisConnections, createRedisConnections } from './redis/client.js'
import { createApp } from './app.js'
import { startCloudComputerReconciler } from './modules/cloud-computer/reconciler.js'

/**
 * Boot sequence: validate config (fail fast, no default secrets) -> open
 * PostgreSQL and Redis -> build the app -> listen. Shutdown stops intake,
 * drains in-flight requests within the graceful budget, then closes Redis
 * and the database pool in order.
 */

const config = loadConfig()
const logger = createLogger(config)

const database = createDatabase({
  connectionString: config.DATABASE_URL,
  statementTimeoutMs: config.REQUEST_TIMEOUT_MS,
})
const redis = await createRedisConnections(config.REDIS_URL)

// Self-migrating service: the image ships ./drizzle, migrations are
// idempotent, and a fresh database must never serve with missing tables.
await migrate(database.db, { migrationsFolder: 'drizzle' })
logger.info('database schema migrated')

const { hono, cloudComputers } = await createApp({ config, database, redis, logger })
const stopCloudComputers = startCloudComputerReconciler(cloudComputers, logger)

// 热重载可靠性：tsx watch 改文件即 SIGTERM 旧进程并立刻拉起新进程，
// 若旧进程握着端口不放，新进程 EADDRINUSE 直接退出且不会自行重试——
// 表现为「改了代码但接口还是旧行为」或「后端没了」。两根支柱：
// ① dev 优雅期压到 1.5s（丢一两个 in-flight 请求无妨），端口立刻释放；
// ② 监听失败（EADDRINUSE）时短退避重试，覆盖新旧进程交接窗口。
const gracefulTimeoutMs = config.NODE_ENV === 'development'
  ? Math.min(config.SERVER_GRACEFUL_TIMEOUT_MS, 1_500)
  : config.SERVER_GRACEFUL_TIMEOUT_MS

const server = serve({ fetch: hono.fetch, port: config.PORT }, (info) => {
  logger.info({ port: info.port, env: config.NODE_ENV }, 'listening')
})
// serve() 返回的即 http server（adaptor 混合体），错误监听直接挂上
const nodeServer = server as unknown as import('node:http').Server
nodeServer.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EADDRINUSE') { return }
  logger.warn({ port: config.PORT }, 'port busy during hot reload; retrying bind')
  const retry = (left: number) => {
    if (left <= 0) { return }
    setTimeout(() => {
      nodeServer.close()
      nodeServer.listen({ port: config.PORT }, () => {
        logger.info({ port: config.PORT, env: config.NODE_ENV }, 'listening (after hot-reload rebind)')
      })
      if (left - 1 > 0) { retry(left - 1) }
    }, 750)
  }
  retry(10)
})

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'shutdown_started')
  const drained = new Promise<void>((resolve) => server.close(() => resolve()))
  const cloudDrained = stopCloudComputers()
  const budgetExhausted = new Promise<void>((resolve) => setTimeout(resolve, gracefulTimeoutMs).unref())
  await Promise.race([Promise.all([drained, cloudDrained]), budgetExhausted])
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
