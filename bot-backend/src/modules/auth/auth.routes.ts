import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import type { Context } from 'hono'
import type { RedisClientType } from 'redis'
import type { Db } from '../../db/client.js'
import type { Config } from '../../config/env.js'
import type { AppEnv } from '../../shared/context.js'
import { requireAuthContext } from '../../shared/context.js'
import { AuthService, type RequestContext } from './auth.service.js'
import { byBodyEmail, byRealIp, rateLimitMiddleware } from '../../middleware/rateLimit.js'
import { validationHook } from '../../middleware/validate.js'
import {
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  verifySchema,
} from './schemas.js'

/**
 * Route identity policy. The public surface is exactly the method+path list in
 * the architecture doc: register, verify (+resend), login, refresh, forgot,
 * reset. Everything else under /v1 mounts behind the authenticate chain.
 * Membership in /auth confers no exemption by itself — logout, for instance,
 * is registered on the protected tree.
 */

export interface AuthRouteDeps {
  db: Db
  redis: RedisClientType
  config: Config
  service: AuthService
}

function requestContext(c: Context<AppEnv>): RequestContext {
  return {
    requestId: c.get('requestId'),
    ip: c.get('realIp'),
    userAgent: c.req.header('user-agent') ?? null,
  }
}

/** Public auth endpoints, each with its own distributed rate-limit buckets. */
export function createAuthPublicRoutes(deps: AuthRouteDeps): Hono<AppEnv> {
  const { config, redis, service } = deps
  const routes = new Hono<AppEnv>()

  const ipBucket = (scope: string, limit: number, windowSeconds: number) =>
    rateLimitMiddleware({ redis, scope, limit, windowSeconds, subject: byRealIp })
  const accountBucket = (scope: string, limit: number, windowSeconds: number) =>
    rateLimitMiddleware({ redis, scope, limit, windowSeconds, subject: byBodyEmail() })

  // POST /v1/auth/register — public, rate limited, validated.
  routes.post(
    '/register',
    ipBucket('register-ip', config.RATE_LIMIT_REGISTER_IP_MAX, config.RATE_LIMIT_REGISTER_IP_WINDOW_SECONDS),
    accountBucket('register-account', config.RATE_LIMIT_REGISTER_IP_MAX, config.RATE_LIMIT_REGISTER_IP_WINDOW_SECONDS),
    zValidator('json', registerSchema, validationHook),
    async (c) => {
      const result = await service.register(c.req.valid('json'), requestContext(c))
      return c.json({ data: result }, 202)
    },
  )

  // POST /v1/auth/verify — one-time credential check.
  routes.post(
    '/verify',
    ipBucket('verify-ip', config.RATE_LIMIT_VERIFY_IP_MAX, config.RATE_LIMIT_VERIFY_IP_WINDOW_SECONDS),
    zValidator('json', verifySchema, validationHook),
    async (c) => {
      const result = await service.verifyEmail(c.req.valid('json'), requestContext(c))
      return c.json({ data: result }, 200)
    },
  )

  // POST /v1/auth/verify/resend — restricted re-issue of verification mail.
  routes.post(
    '/verify/resend',
    ipBucket('register-ip', config.RATE_LIMIT_REGISTER_IP_MAX, config.RATE_LIMIT_REGISTER_IP_WINDOW_SECONDS),
    accountBucket('register-account', config.RATE_LIMIT_REGISTER_IP_MAX, config.RATE_LIMIT_REGISTER_IP_WINDOW_SECONDS),
    zValidator('json', resendVerificationSchema, validationHook),
    async (c) => {
      const result = await service.resendVerification(c.req.valid('json'), requestContext(c))
      return c.json({ data: result }, 202)
    },
  )

  // POST /v1/auth/login — public, limited by IP and by normalized account.
  routes.post(
    '/login',
    ipBucket('login-ip', config.RATE_LIMIT_LOGIN_IP_MAX, config.RATE_LIMIT_LOGIN_IP_WINDOW_SECONDS),
    accountBucket('login-account', config.RATE_LIMIT_LOGIN_ACCOUNT_MAX, config.RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_SECONDS),
    zValidator('json', loginSchema, validationHook),
    async (c) => {
      const result = await service.login(c.req.valid('json'), requestContext(c))
      return c.json({ data: result }, 200)
    },
  )

  // POST /v1/auth/refresh — authenticates via the refresh credential itself.
  routes.post(
    '/refresh',
    ipBucket('refresh-ip', config.RATE_LIMIT_LOGIN_IP_MAX, config.RATE_LIMIT_LOGIN_IP_WINDOW_SECONDS),
    zValidator('json', refreshSchema, validationHook),
    async (c) => {
      const result = await service.refresh(c.req.valid('json'), requestContext(c))
      return c.json({ data: result }, 200)
    },
  )

  // POST /v1/auth/password/forgot — public, limited, uniform response.
  routes.post(
    '/password/forgot',
    ipBucket('forgot-ip', config.RATE_LIMIT_FORGOT_IP_MAX, config.RATE_LIMIT_FORGOT_IP_WINDOW_SECONDS),
    accountBucket('forgot-account', config.RATE_LIMIT_FORGOT_ACCOUNT_MAX, config.RATE_LIMIT_FORGOT_ACCOUNT_WINDOW_SECONDS),
    zValidator('json', forgotPasswordSchema, validationHook),
    async (c) => {
      const result = await service.forgotPassword(c.req.valid('json'), requestContext(c))
      return c.json({ data: result }, 202)
    },
  )

  // POST /v1/auth/password/reset — one-time recovery credential.
  routes.post(
    '/password/reset',
    ipBucket('verify-ip', config.RATE_LIMIT_VERIFY_IP_MAX, config.RATE_LIMIT_VERIFY_IP_WINDOW_SECONDS),
    zValidator('json', resetPasswordSchema, validationHook),
    async (c) => {
      const result = await service.resetPassword(c.req.valid('json'), requestContext(c))
      return c.json({ data: result }, 200)
    },
  )

  return routes
}

/** POST /v1/auth/logout — authenticated; revokes the current device session. */
export function registerLogoutRoute(app: Hono<AppEnv>, service: AuthService): void {
  app.post('/v1/auth/logout', async (c) => {
    const result = await service.logout(requireAuthContext(c), requestContext(c))
    return c.json({ data: result }, 200)
  })
}
