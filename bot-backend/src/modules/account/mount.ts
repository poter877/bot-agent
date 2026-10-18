import type { Hono } from 'hono'
import type { RedisClientType } from 'redis'
import type { AppConfig } from '../../config/env.js'
import type { Db } from '../../db/client.js'
import type { AppEnv } from '../../shared/context.js'
import { authenticate } from '../../middleware/auth.js'
import { authenticateUserToken } from '../../middleware/authenticateUserToken.js'
import { bodyPolicyMiddleware } from '../../middleware/bodyPolicy.js'
import { byAuthUserId, rateLimitMiddleware } from '../../middleware/rateLimit.js'
import type { Logger } from '../../shared/logger.js'
import type { Auth } from '../auth/auth.js'
import { createAccountRoutes } from './account.routes.js'
import { createDeviceRoutes } from './device.routes.js'
import { createTokenRoutes } from './token.routes.js'

/**
 * 用户自服务层统一挂载（对标 Nous Portal：账号门户 + API 令牌 + 设备码登录）。
 *
 * 在 app.ts（createApp）中调用一次，位置必须在 `app.all('/api/auth/*', …)`
 * （Better Auth handler）之前——设备码路由挂在 /api/auth/device/*，后注册会被
 * 该 handler 吞掉；排在它之前也就天然先于 /api/llm/*、/api/media/* 的内联
 * 会话检查，bearer 中间件得以先 settle 身份。
 *
 * 各树的限流沿用既有中间件：
 *   /api/auth/device/* —— 随 /api/auth/* 树的 entry-ip 桶（此处不再重复挂）
 *   /api/account/*     —— bodyPolicy + authenticate + scope 'user'（按用户）
 *   /account/*         —— scope 'entry-ip'（与 /admin 一致的洪水防护）
 *
 * 前置条件：调用点之前 realIp 已解析（app.ts 全局 realIpMiddleware 先于
 * app.all 的位置即可满足）。
 */

export interface MountAccountDeps {
  config: AppConfig
  db: Db
  redis: RedisClientType
  logger: Logger
  auth: Auth
}

export function mountAccount(app: Hono<AppEnv>, deps: MountAccountDeps): void {
  const { config, db, redis, logger, auth } = deps

  // 1) 用户 API 令牌（Bearer bat_…）加入模型/媒体树的凭证族：非 bat_ 或无
  //    Authorization 的请求原样放行，服务令牌与会话流程不受影响。
  app.use('/api/llm/*', authenticateUserToken(db))
  app.use('/api/media/*', authenticateUserToken(db))

  // 2) 设备码登录：code/token 匿名，approve 需会话；body/entry-ip 由既有
  //    /api/auth/* 树策略覆盖。
  app.use('/api/auth/device/approve', authenticate(auth))
  app.route('/api/auth/device', createDeviceRoutes({ config, db }))

  // 3) 用户令牌 JSON CRUD：会话登录者，按用户限流。
  app.use('/api/account/*', bodyPolicyMiddleware(config.API_BODY_LIMIT_BYTES))
  app.use('/api/account/*', authenticate(auth))
  app.use(
    '/api/account/*',
    rateLimitMiddleware({
      redis,
      scope: 'user',
      limit: config.RATE_LIMIT_USER_MAX,
      windowSeconds: config.RATE_LIMIT_USER_WINDOW_SECONDS,
      subject: byAuthUserId,
    }),
  )
  app.route('/api/account/tokens', createTokenRoutes(db))

  // 4) 用户门户（HTML，form-post）：entry-ip 洪水防护即可（低频页面）。
  app.use(
    '/account/*',
    rateLimitMiddleware({
      redis,
      scope: 'entry-ip',
      limit: config.RATE_LIMIT_ENTRY_MAX,
      windowSeconds: config.RATE_LIMIT_ENTRY_WINDOW_SECONDS,
      subject: (c) => c.get('realIp'),
    }),
  )
  app.route('/account', createAccountRoutes({ config, db, redis, logger, auth }))
}
