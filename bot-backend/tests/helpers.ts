import { readFileSync } from 'node:fs'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config/env.js'
import { closeDatabase, createDatabase, type Database } from '../src/db/client.js'
import { closeRedisConnections, createRedisConnections, type RedisConnections } from '../src/redis/client.js'
import { createLogger, type Logger } from '../src/shared/logger.js'
import { createApp } from '../src/app.js'
import type { Hono } from 'hono'
import type { AppEnv } from '../src/shared/context.js'

const INFO_FILE = path.join(process.cwd(), 'node_modules', '.bot-backend-test-infra.json')

interface InfraInfo {
  databaseUrl: string
  redisUrl: string
}

export function testInfra(): InfraInfo {
  return JSON.parse(readFileSync(INFO_FILE, 'utf8')) as InfraInfo
}

export const TEST_AUTH_SECRET = 'unit-test-secret-0123456789abcdef0123456789abcdef'
export const TEST_BASE_URL = 'http://127.0.0.1:3100'

export interface TestApp {
  config: Config
  database: Database
  redis: RedisConnections
  logger: Logger
  app: Hono<AppEnv>
  close(): Promise<void>
}

export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const infra = testInfra()
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DATABASE_URL: infra.databaseUrl,
    REDIS_URL: infra.redisUrl,
    BETTER_AUTH_SECRET: TEST_AUTH_SECRET,
    BETTER_AUTH_URL: TEST_BASE_URL,
    ...overrides,
  })
  const database = createDatabase({
    connectionString: config.DATABASE_URL,
    statementTimeoutMs: config.REQUEST_TIMEOUT_MS,
  })
  const redis = await createRedisConnections(config.REDIS_URL)
  const logger = createLogger(config)
  const { hono } = await createApp({ config, database, redis, logger })
  return {
    config,
    database,
    redis,
    logger,
    app: hono,
    close: async () => {
      await closeRedisConnections(redis)
      await closeDatabase(database)
    },
  }
}

export async function truncateAll(database: Database): Promise<void> {
  await database.pool.query('TRUNCATE "user", session, account, verification CASCADE')
}

export function flushRateLimits(redis: RedisConnections): Promise<void> {
  return redis.commands.flushDb()
}

export function jsonRequest(
  app: Hono<AppEnv>,
  method: 'GET' | 'POST',
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(urlPath, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export function uniqueEmail(): string {
  return `user-${crypto.randomUUID()}@test.local`
}

/** Join every Set-Cookie into one Cookie header value for the next request. */
export function cookieFrom(response: Response): string {
  const cookies = response.headers.getSetCookie()
  if (cookies.length === 0) {
    throw new Error(`no set-cookie in response (status ${response.status})`)
  }
  return cookies.map((cookie) => cookie.split(';')[0]).join('; ')
}

export interface RegisteredUser {
  userId: string
  email: string
  password: string
  cookie: string
}

/** Better Auth email+password onboarding: sign-up returns the live session. */
export async function registerUser(
  app: Hono<AppEnv>,
  database: Database,
  email: string,
  password: string,
): Promise<RegisteredUser> {
  const response = await jsonRequest(app, 'POST', '/api/auth/sign-up/email', {
    name: email.split('@')[0],
    email,
    password,
  })
  if (response.status !== 200) {
    throw new Error(`sign-up failed: ${response.status} ${await response.text()}`)
  }
  const cookie = cookieFrom(response)
  const rows = await database.pool.query('SELECT id FROM "user" WHERE email = $1', [email])
  return { userId: rows.rows[0]!.id as string, email, password, cookie }
}

export async function signIn(
  app: Hono<AppEnv>,
  email: string,
  password: string,
): Promise<Response> {
  return jsonRequest(app, 'POST', '/api/auth/sign-in/email', { email, password })
}

export async function getSession(
  app: Hono<AppEnv>,
  cookie: string,
): Promise<{ session: { id: string; userId: string }; user: { id: string; email: string; name: string } } | null> {
  const response = await jsonRequest(app, 'GET', '/api/auth/get-session', undefined, { cookie })
  const body = (await response.json()) as { session: { id: string; userId: string }; user: { id: string; email: string; name: string } } | null
  return body
}

export async function me(
  app: Hono<AppEnv>,
  cookie: string,
): Promise<Response> {
  return jsonRequest(app, 'GET', '/v1/users/me', undefined, { cookie })
}
