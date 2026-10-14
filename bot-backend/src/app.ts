import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Database } from './db/client.js'
import type { RedisConnections } from './redis/client.js'
import type { Config } from './config/env.js'
import type { Logger } from './shared/logger.js'
import type { AppEnv } from './shared/context.js'
import { HttpApiError } from './shared/http.js'
import { serverRequestId } from './middleware/requestId.js'
import { accessLogMiddleware } from './middleware/accessLog.js'
import { securityMiddleware } from './middleware/security.js'
import { realIpMiddleware } from './middleware/realIp.js'
import { processingTimeout } from './middleware/timeout.js'
import { bodyPolicyMiddleware } from './middleware/bodyPolicy.js'
import { byAuthUserId, accountBucketKey, rateLimitMiddleware, enforceBucket } from './middleware/rateLimit.js'
import { authenticate } from './middleware/auth.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { createAuth, type Auth } from './modules/auth/auth.js'
import { createUsersRoutes } from './modules/users/users.routes.js'
import { createHealthRoutes } from './modules/health/health.routes.js'

export interface AppDeps {
  config: Config
  database: Database
  redis: RedisConnections
  logger: Logger
}

export interface App {
  hono: Hono<AppEnv>
  auth: Auth
}

/**
 * Explicit assembly. Authentication is delegated to Better Auth: its
 * /api/auth/* handler mounts PUBLIC (register/login must never sit behind a
 * login gate, doc §4), and every other /v1 route runs behind the getSession
 * check. The doc's common request boundary still applies to both trees:
 *
 *   request id -> security headers -> CORS -> real IP -> processing budget
 *   -> body policy -> entry rate limit -> (per-account buckets on
 *   sign-in/sign-up) -> Better Auth handler -> authenticate (getSession,
 *   authoritative store) -> per-user rate limit -> protected routes
 *
 * The full 16-middleware production chain (§5) stays the blueprint for the
 * future full backend; this assembly keeps the auth-necessary subset.
 */
export async function createApp(deps: AppDeps): Promise<App> {
  const { config, database, redis, logger } = deps
  const db = database.db

  const auth = createAuth(config, database)

  const app = new Hono<AppEnv>()

  app.onError(errorHandler(logger))
  app.notFound(notFoundHandler())

  app.use(serverRequestId())
  app.use(accessLogMiddleware(logger))
  for (const middleware of securityMiddleware()) {
    app.use(middleware)
  }
  if (config.CORS_ALLOWED_ORIGINS.length > 0) {
    // Better Auth authenticates with cookies, so credentialed CORS is
    // required the day a browser client joins; origins stay an exact list.
    app.use(
      '*',
      cors({
        origin: config.CORS_ALLOWED_ORIGINS,
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
        maxAge: 600,
        credentials: true,
      }),
    )
  }
  app.use(realIpMiddleware(config.TRUSTED_PROXIES))
  app.use(processingTimeout(config.REQUEST_TIMEOUT_MS))

  for (const tree of ['/api/auth/*', '/v1/*']) {
    app.use(tree, bodyPolicyMiddleware(config.API_BODY_LIMIT_BYTES))
    app.use(
      tree,
      rateLimitMiddleware({
        redis: redis.commands,
        scope: 'entry-ip',
        limit: config.RATE_LIMIT_ENTRY_MAX,
        windowSeconds: config.RATE_LIMIT_ENTRY_WINDOW_SECONDS,
        subject: (c) => c.get('realIp'),
      }),
    )
  }

  // Per-account buckets on the credential endpoints, then hand off to the
  // library. Better Auth clones the Request internally and a consumed body
  // cannot be cloned, so for JSON credential posts we parse once, enforce the
  // bucket, and rebuild a fresh unread Request from the parsed body; every
  // other request passes through untouched.
  const accountBuckets = [
    {
      path: '/api/auth/sign-in/email',
      scope: 'login-account',
      limit: config.RATE_LIMIT_LOGIN_ACCOUNT_MAX,
      windowSeconds: config.RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_SECONDS,
    },
    {
      path: '/api/auth/sign-up/email',
      scope: 'register-account',
      limit: config.RATE_LIMIT_REGISTER_IP_MAX,
      windowSeconds: config.RATE_LIMIT_REGISTER_IP_WINDOW_SECONDS,
    },
  ] as const

  app.all('/api/auth/*', async (c) => {
    const contentType = c.req.header('content-type') ?? ''
    const bucket =
      c.req.method === 'POST' && contentType.includes('application/json')
        ? accountBuckets.find((spec) => c.req.path === spec.path)
        : undefined
    if (bucket === undefined) {
      return auth.handler(c.req.raw)
    }
    const parsed = await c.req.json().catch(() => null)
    if (parsed === null) {
      // Malformed JSON on a credential endpoint keeps the service-wide 400
      // contract instead of a library-shaped error.
      throw new HttpApiError(400, 'invalid_json', 'Request body is not valid JSON.')
    }
    const email = (parsed as Record<string, unknown>)['email']
    if (typeof email === 'string' && email.trim() !== '') {
      await enforceBucket(redis.commands, bucket.scope, accountBucketKey(email), bucket.limit, bucket.windowSeconds)
    }
    const fresh = new Request(c.req.raw.url, {
      method: 'POST',
      headers: c.req.raw.headers,
      body: JSON.stringify(parsed),
      duplex: 'half',
    })
    return auth.handler(fresh)
  })

  // Everything below requires a verified Better Auth session.
  app.use('/v1/*', authenticate(auth))
  app.use(
    '/v1/*',
    rateLimitMiddleware({
      redis: redis.commands,
      scope: 'user',
      limit: config.RATE_LIMIT_USER_MAX,
      windowSeconds: config.RATE_LIMIT_USER_WINDOW_SECONDS,
      subject: byAuthUserId,
    }),
  )
  app.route('/v1/users', createUsersRoutes(db))

  app.route('/', createHealthRoutes(database, redis.commands))

  return { hono: app, auth }
}
