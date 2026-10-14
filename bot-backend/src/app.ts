import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Database } from './db/client.js'
import type { RedisConnections } from './redis/client.js'
import type { Config } from './config/env.js'
import type { Logger } from './shared/logger.js'
import type { AppEnv } from './shared/context.js'
import { serverRequestId } from './middleware/requestId.js'
import { accessLogMiddleware } from './middleware/accessLog.js'
import { securityMiddleware } from './middleware/security.js'
import { realIpMiddleware } from './middleware/realIp.js'
import { processingTimeout } from './middleware/timeout.js'
import { bodyPolicyMiddleware } from './middleware/bodyPolicy.js'
import { byAuthUserId, rateLimitMiddleware } from './middleware/rateLimit.js'
import { authenticate } from './middleware/auth.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { AuthService } from './modules/auth/auth.service.js'
import { createAuthPublicRoutes, registerLogoutRoute } from './modules/auth/auth.routes.js'
import { PasswordHasher } from './modules/auth/password.js'
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
  authService: AuthService
}

/**
 * Explicit assembly with the doc's fixed pipeline order:
 *
 *   request id -> security headers -> CORS -> real IP -> processing budget
 *   -> body policy -> entry rate limit -> public auth allowlist
 *   -> authenticate (JWT + server-side session) -> per-user rate limit
 *   -> protected routes (default-authenticated)
 *
 * /healthz and /readyz stay outside /v1: liveness needs no dependencies, and
 * readiness reports only ok/unavailable.
 */
export async function createApp(deps: AppDeps): Promise<App> {
  const { config, database, redis, logger } = deps
  const db = database.db

  const hasher = await PasswordHasher.create(config)
  const authService = new AuthService({ db, config, hasher, redis: redis.commands, logger })

  const app = new Hono<AppEnv>()

  app.onError(errorHandler(logger))
  app.notFound(notFoundHandler())

  app.use(serverRequestId())
  app.use(accessLogMiddleware(logger))
  for (const middleware of securityMiddleware()) {
    app.use(middleware)
  }
  if (config.CORS_ALLOWED_ORIGINS.length > 0) {
    app.use(
      '/v1/*',
      cors({
        origin: config.CORS_ALLOWED_ORIGINS,
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
        maxAge: 600,
        credentials: false,
      }),
    )
  }
  app.use(realIpMiddleware(config.TRUSTED_PROXIES))
  app.use(processingTimeout(config.REQUEST_TIMEOUT_MS))
  app.use('/v1/*', bodyPolicyMiddleware(config.API_BODY_LIMIT_BYTES))
  app.use(
    '/v1/*',
    rateLimitMiddleware({
      redis: redis.commands,
      scope: 'entry-ip',
      limit: config.RATE_LIMIT_ENTRY_MAX,
      windowSeconds: config.RATE_LIMIT_ENTRY_WINDOW_SECONDS,
      subject: (c) => c.get('realIp'),
    }),
  )

  // Public allowlist, precise to method+path.
  app.route('/v1/auth', createAuthPublicRoutes({ db, redis: redis.commands, config, service: authService }))

  // Everything below requires a verified token AND live server-side session.
  app.use('/v1/*', authenticate(config, db))
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
  registerLogoutRoute(app, authService)
  app.route('/v1/users', createUsersRoutes(db))

  app.route('/', createHealthRoutes(database, redis.commands))

  return { hono: app, authService }
}
