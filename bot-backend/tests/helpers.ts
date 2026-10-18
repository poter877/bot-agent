import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { loadConfig, type Config } from '../src/config/env.js'
import { closeDatabase, createDatabase, type Database } from '../src/db/client.js'
import { closeRedisConnections, createRedisConnections, type RedisConnections } from '../src/redis/client.js'
import { createLogger, type Logger } from '../src/shared/logger.js'
import { createApp } from '../src/app.js'
import { errorHandler, notFoundHandler } from '../src/middleware/errorHandler.js'
import { realIpMiddleware } from '../src/middleware/realIp.js'
import { bodyPolicyMiddleware } from '../src/middleware/bodyPolicy.js'
import { rateLimitMiddleware } from '../src/middleware/rateLimit.js'
import { mountAccount } from '../src/modules/account/mount.js'
import { mountToolsGateway } from '../src/modules/tools/mount.js'
import type { MediaCatalogEntry } from '../src/modules/media/catalog.js'
import type { createMediaRoutes } from '../src/modules/media/media.routes.js'
import type { AudioRoutesDeps } from '../src/modules/media/audio.routes.js'
import type { AppEnv } from '../src/shared/context.js'
import type { CloudComputerService } from '../src/modules/cloud-computer/service.js'

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
  cloudComputers: CloudComputerService | null
  close(): Promise<void>
}

export async function createTestApp(
  overrides: Record<string, string> = {},
  llm?: Parameters<typeof createApp>[0]['llm'],
  cloudComputer?: Parameters<typeof createApp>[0]['cloudComputer'],
  media?: Pick<Parameters<typeof createMediaRoutes>[0], 'imageGenerator' | 'videoGenerator' | 'imageCatalog' | 'videoCatalog' | 'pollingDeps'>,
  audio?: Pick<AudioRoutesDeps, 'speechGenerator' | 'transcriber'>,
  /** Mount the managed tool gateway (/api/tools) — the app.ts snippet runs in
   * the main session; tests exercise the same mountToolsGateway call. */
  tools?: boolean,
): Promise<TestApp> {
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
  const real = await createApp({ config, database, redis, logger, llm, cloudComputer, media, audio })
  if (tools) {
    // Same helper the app.ts snippet calls: entry-ip guard → session/service
    // auth → tools-scope per-user budget → routes, on the real app tree.
    mountToolsGateway(real.hono, { config, auth: real.auth, redis, logger })
  }
  // src/app.ts 由主会话统一接线：这里用同一份 mountAccount（生产挂载片段）
  // 包一层，仅补齐生产里由 /api/auth/* 树提供的 body/entry-ip 策略与 realIp
  // （wrapper 内设备码路由先于真 app 命中，拿不到 app 内的全局中间件）。
  const app = new Hono<AppEnv>()
  app.onError(errorHandler(logger))
  // route() 合并的是路由而非 sub-app 的 notFound：未命中路径由 wrapper 自己兜底。
  app.notFound(notFoundHandler())
  app.use(realIpMiddleware(config.TRUSTED_PROXIES))
  app.use('/api/auth/device/*', bodyPolicyMiddleware(config.API_BODY_LIMIT_BYTES))
  app.use(
    '/api/auth/device/*',
    rateLimitMiddleware({
      redis: redis.commands,
      scope: 'entry-ip',
      limit: config.RATE_LIMIT_ENTRY_MAX,
      windowSeconds: config.RATE_LIMIT_ENTRY_WINDOW_SECONDS,
      subject: (c) => c.get('realIp'),
    }),
  )
  mountAccount(app, { config, db: database.db, redis: redis.commands, logger, auth: real.auth })
  app.route('/', real.hono)
  return {
    config,
    database,
    redis,
    logger,
    app,
    cloudComputers: real.cloudComputers,
    close: async () => {
      await closeRedisConnections(redis)
      await closeDatabase(database)
    },
  }
}

export async function truncateAll(database: Database): Promise<void> {
  await database.pool.query(
    'TRUNCATE "user", session, account, verification, llm_models, media_models, user_quotas, llm_request_log, api_tokens, device_codes CASCADE',
  )
}

export async function flushRateLimits(redis: RedisConnections): Promise<void> {
  await redis.commands.flushDb()
}

export async function jsonRequest(
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
