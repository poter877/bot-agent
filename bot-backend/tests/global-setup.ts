import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RedisMemoryServer } from 'redis-memory-server'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'

/**
 * Test infrastructure: a throwaway PostgreSQL cluster (initdb into a temp
 * dir — the host system is never touched) plus a real in-memory Redis via
 * redis-memory-server. CI can skip both by providing
 * BOT_BACKEND_TEST_DATABASE_URL / BOT_BACKEND_TEST_REDIS_URL.
 */

const INFO_FILE = path.join(process.cwd(), 'node_modules', '.bot-backend-test-infra.json')

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))))
    })
    server.on('error', reject)
  })
}

async function startPostgres(): Promise<{ databaseUrl: string; stop: () => Promise<void> }> {
  const pgBin = process.env.PG_BIN ?? path.dirname(execFileSync('which', ['initdb']).toString().trim())
  const dataDir = mkdtempSync(path.join(tmpdir(), 'bot-backend-pg-'))
  const socketDir = mkdtempSync(path.join(tmpdir(), 'bot-backend-pg-sock-'))
  execFileSync(
    path.join(pgBin, 'initdb'),
    ['-D', dataDir, '-A', 'trust', '-U', 'postgres', '--no-locale', '-E', 'UTF8'],
    { stdio: 'ignore' },
  )
  const port = await findFreePort()
  const process_ = spawn(
    path.join(pgBin, 'postgres'),
    [
      '-D', dataDir,
      '-p', String(port),
      '-k', socketDir,
      '-c', 'listen_addresses=127.0.0.1',
      '-c', 'fsync=off',
      '-c', 'synchronous_commit=off',
      '-c', 'full_page_writes=off',
    ],
    { stdio: 'ignore' },
  )
  const isReady = () => {
    try {
      execFileSync(path.join(pgBin, 'pg_isready'), ['-h', '127.0.0.1', '-p', String(port)], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  for (let attempt = 0; attempt < 60 && !isReady(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (!isReady()) {
    process_.kill('SIGKILL')
    throw new Error('temporary PostgreSQL did not become ready')
  }
  execFileSync(
    path.join(pgBin, 'psql'),
    ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-c', 'CREATE DATABASE bot_backend_test'],
    { stdio: 'ignore' },
  )
  return {
    databaseUrl: `postgres://postgres@127.0.0.1:${port}/bot_backend_test`,
    stop: async () => {
      process_.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          if (process_.exitCode !== null) {
            clearInterval(poll)
            resolve()
          }
        }, 50)
        setTimeout(() => {
          clearInterval(poll)
          process_.kill('SIGKILL')
          resolve()
        }, 5000).unref()
      })
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(socketDir, { recursive: true, force: true })
    },
  }
}

async function startRedis(): Promise<{ redisUrl: string; stop: () => Promise<void> }> {
  const server = new RedisMemoryServer({ instance: { port: 0, ip: '127.0.0.1' } })
  const port = await server.getPort()
  return {
    redisUrl: `redis://127.0.0.1:${port}`,
    stop: async () => { await server.stop() },
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const teardowns: Array<() => Promise<void>> = []

  let databaseUrl = process.env.BOT_BACKEND_TEST_DATABASE_URL
  if (!databaseUrl) {
    const postgres = await startPostgres()
    databaseUrl = postgres.databaseUrl
    teardowns.push(postgres.stop)
  }

  let redisUrl = process.env.BOT_BACKEND_TEST_REDIS_URL
  if (!redisUrl) {
    const redis = await startRedis()
    redisUrl = redis.redisUrl
    teardowns.push(redis.stop)
  }

  // Apply the reviewed SQL migrations exactly like a release step would.
  const migrator = drizzle(databaseUrl)
  await migrate(migrator, { migrationsFolder: path.join(process.cwd(), 'drizzle') })
  const client = (migrator as unknown as { $client: { end: () => Promise<void> } }).$client
  await client.end()

  writeFileSync(INFO_FILE, JSON.stringify({ databaseUrl, redisUrl }))

  return async () => {
    for (const teardown of teardowns.reverse()) {
      await teardown()
    }
    rmSync(INFO_FILE, { force: true })
  }
}
