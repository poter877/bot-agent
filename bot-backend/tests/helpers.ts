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

export const TEST_JWT_SECRET = 'unit-test-secret-0123456789abcdef0123456789abcdef'

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
    AUTH_JWT_SECRET: TEST_JWT_SECRET,
    MAIL_TRANSPORT: 'log',
    MAIL_FROM: 'test@bot-backend.invalid',
    APP_BASE_URL: 'https://accounts.test.local',
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
  await database.pool.query(
    'TRUNCATE users, login_sessions, verification_tokens, auth_audit, mail_outbox CASCADE',
  )
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

export function extractTokenFromMailBody(bodyText: string): string {
  const match = /token=([A-Za-z0-9_-]+)/.exec(bodyText)
  if (match === null) {
    throw new Error(`no token found in mail body: ${bodyText}`)
  }
  return match[1]!
}

export interface RegisteredUser {
  userId: string
  email: string
  password: string
}

/** Runs the full ToC onboarding: register -> read mail outbox -> verify. */
export async function registerAndVerify(
  app: Hono<AppEnv>,
  database: Database,
  email: string,
  password: string,
): Promise<RegisteredUser> {
  const registered = await jsonRequest(app, 'POST', '/v1/auth/register', { email, password })
  if (registered.status !== 202) {
    throw new Error(`register failed: ${registered.status} ${await registered.text()}`)
  }
  const outbox = await database.pool.query(
    "SELECT body_text FROM mail_outbox WHERE purpose = 'verify_email' ORDER BY created_at DESC LIMIT 1",
  )
  const token = extractTokenFromMailBody(outbox.rows[0]!.body_text as string)
  const verified = await jsonRequest(app, 'POST', '/v1/auth/verify', { token })
  if (verified.status !== 200) {
    throw new Error(`verify failed: ${verified.status} ${await verified.text()}`)
  }
  const userRow = await database.pool.query('SELECT id FROM users WHERE email = $1', [email])
  return { userId: userRow.rows[0]!.id as string, email, password }
}

export interface LoginResult {
  accessToken: string
  refreshToken: string
  expiresInSeconds: number
  user: { id: string; email: string; displayName: string; status: string }
}

export async function login(
  app: Hono<AppEnv>,
  email: string,
  password: string,
): Promise<LoginResult> {
  const response = await jsonRequest(app, 'POST', '/v1/auth/login', { email, password })
  if (response.status !== 200) {
    throw new Error(`login failed: ${response.status} ${await response.text()}`)
  }
  const body = (await response.json()) as { data: LoginResult }
  return body.data
}

export function uniqueEmail(): string {
  return `user-${crypto.randomUUID()}@test.local`
}
