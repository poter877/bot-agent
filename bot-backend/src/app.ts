import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Database } from './db/client.js'
import type { RedisConnections } from './redis/client.js'
import type { Config } from './config/env.js'
import type { Logger } from './shared/logger.js'
import type { AppEnv } from './shared/context.js'
import { serviceAuth } from './shared/context.js'
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
import { createLlmRoutes } from './modules/llm/llm.routes.js'
import { createChatCompletionsRoutes } from './modules/llm/chat-completions.js'
import { createMediaRoutes } from './modules/media/media.routes.js'
import { createAudioRoutes } from './modules/media/audio.routes.js'
import { createFalQueueProxyRoutes } from './modules/media/fal-proxy.js'
import type { MediaCatalogEntry } from './modules/media/catalog.js'
import { CatalogStore, parseModelCatalog } from './modules/llm/catalog.js'
import { createAdminRoutes } from './modules/admin/admin.routes.js'
import { createCloudComputerRoutes } from './modules/cloud-computer/cloud-computer.routes.js'
import { CloudComputerService } from './modules/cloud-computer/service.js'
import { HttpCloudWorker } from './modules/cloud-computer/worker-client.js'
import type { CloudWorker } from './modules/cloud-computer/protocol.js'

export interface AppDeps {
  config: Config
  database: Database
  redis: RedisConnections
  logger: Logger
  /** Test seams for the model stream route (defaults: env catalog + env keys). */
  llm?: { modelResolver?: Parameters<typeof createLlmRoutes>[0]['modelResolver']; catalog?: Parameters<typeof createLlmRoutes>[0]['catalog'] }
  /** Test seams for the media routes. */
  media?: Pick<Parameters<typeof createMediaRoutes>[0], 'imageGenerator' | 'videoGenerator' | 'imageCatalog' | 'videoCatalog'>
  /** Test seams for the audio routes. */
  audio?: Pick<Parameters<typeof createAudioRoutes>[0], 'speechGenerator' | 'transcriber'>
  cloudComputer?: { worker: CloudWorker }
}

export interface App {
  hono: Hono<AppEnv>
  auth: Auth
  cloudComputers: CloudComputerService | null
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
  const cloudComputers = config.CLOUD_COMPUTER_ENABLED
    ? new CloudComputerService(db, deps.cloudComputer?.worker ?? new HttpCloudWorker(config.CLOUD_COMPUTER_WORKER_URL!, config.CLOUD_COMPUTER_WORKER_TOKEN!))
    : null
  // The console-owned model directory: llm_models is the source of truth,
  // LLM_MODEL_CATALOG only seeds an empty table (运营后台 CRUD 目标).
  const catalogStore = new CatalogStore(db, parseModelCatalog(config.LLM_MODEL_CATALOG))

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
  // Media generation (video especially) legitimately runs for minutes: give the
  // media tree its own budget BEFORE the global mount, which would kill it at 10s.
  app.use('/api/media/*', processingTimeout(config.MEDIA_REQUEST_TIMEOUT_MS))
  app.use(processingTimeout(config.REQUEST_TIMEOUT_MS))

  for (const tree of ['/api/auth/*', '/v1/*']) {
    const ordinaryBody = bodyPolicyMiddleware(config.API_BODY_LIMIT_BYTES)
    const cloudBody = bodyPolicyMiddleware(64 * 1024)
    app.use(tree, (c, next) => c.req.path.startsWith('/v1/cloud-computer/') ? cloudBody(c, next) : ordinaryBody(c, next))
    const ordinaryEntryLimit = rateLimitMiddleware({
        redis: redis.commands,
        scope: 'entry-ip',
        limit: config.RATE_LIMIT_ENTRY_MAX,
        windowSeconds: config.RATE_LIMIT_ENTRY_WINDOW_SECONDS,
        subject: (c) => c.get('realIp'),
      })
    const cloudEntryLimit = rateLimitMiddleware({
      redis: redis.commands, scope: 'cloud-computer-ip', limit: config.CLOUD_COMPUTER_IP_RATE_LIMIT_MAX,
      windowSeconds: 60, subject: (c) => c.get('realIp'),
    })
    app.use(tree, (c, next) => c.req.path.startsWith('/v1/cloud-computer/') ? cloudEntryLimit(c, next) : ordinaryEntryLimit(c, next))
  }
  // The model stream carries whole conversations plus tool schemas — a
  // dedicated, larger body budget than the account JSON API (doc §4.1).
  app.use('/api/llm/*', bodyPolicyMiddleware(config.LLM_STREAM_BODY_LIMIT_BYTES))
  app.use(
    '/api/llm/*',
    rateLimitMiddleware({
      redis: redis.commands,
      scope: 'entry-ip',
      limit: config.RATE_LIMIT_ENTRY_MAX,
      windowSeconds: config.RATE_LIMIT_ENTRY_WINDOW_SECONDS,
      subject: (c) => c.get('realIp'),
    }),
  )

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
  const ordinaryUserLimit = rateLimitMiddleware({
      redis: redis.commands,
      scope: 'user',
      limit: config.RATE_LIMIT_USER_MAX,
      windowSeconds: config.RATE_LIMIT_USER_WINDOW_SECONDS,
      subject: byAuthUserId,
    })
  const cloudUserLimit = rateLimitMiddleware({
    redis: redis.commands, scope: 'cloud-computer', limit: config.CLOUD_COMPUTER_RATE_LIMIT_MAX,
    windowSeconds: 60, subject: byAuthUserId,
  })
  app.use('/v1/*', (c, next) => c.req.path.startsWith('/v1/cloud-computer/') ? cloudUserLimit(c, next) : ordinaryUserLimit(c, next))
  app.route('/v1/users', createUsersRoutes(db))
  app.route('/v1/cloud-computer', createCloudComputerRoutes(cloudComputers, new URL(config.BETTER_AUTH_URL).origin))

  // Model streams ride the same Better Auth session (doc《流式服务端重构》§4.1:
  // 凭证传递方式沿用账号后端的实现约定) with their own per-user request budget.
  // Internal service principals (ai-drama 的 mastra agents) present the service
  // token instead — the chat-completions route checks for the marker itself.
  app.use('/api/llm/*', async (c, next) => {
    const token = config.INTERNAL_SERVICE_TOKEN ?? config.MEDIA_SERVICE_TOKEN
    const authz = c.req.header('authorization')
    if (token && authz === `Bearer ${token}`) {
      c.set('auth', serviceAuth(config.MEDIA_SERVICE_USER_ID, 'llm'))
      await next()
      return
    }
    await authenticate(auth)(c, next)
  })
  app.use(
    '/api/llm/*',
    rateLimitMiddleware({
      redis: redis.commands,
      scope: 'llm-stream',
      limit: config.RATE_LIMIT_LLM_STREAM_MAX,
      windowSeconds: config.RATE_LIMIT_LLM_STREAM_WINDOW_SECONDS,
      subject: byAuthUserId,
    }),
  )
  app.route('/api/llm', createChatCompletionsRoutes({ config, db, redis: redis.commands, logger, catalogStore, ...deps.llm }))
  app.route('/api/llm', createLlmRoutes({ config, db, redis: redis.commands, logger, catalogStore, ...deps.llm }))

  // Media generation (image/video/audio): same Better Auth session, own per-user
  // request budget, small JSON bodies, generation errors answer as 502.
  // The fal queue proxy carries submit payloads with inline data URIs and the
  // transcription route takes multipart audio — both get the stream-sized
  // body budget (and, for transcription, the multipart allowance) instead of
  // the small JSON-only media one.
  const mediaBodyPolicy = bodyPolicyMiddleware(config.MEDIA_BODY_LIMIT_BYTES)
  const mediaUploadBodyPolicy = bodyPolicyMiddleware(config.LLM_STREAM_BODY_LIMIT_BYTES, ['application/json', 'multipart/form-data'])
  app.use('/api/media/*', (c, next) =>
    c.req.path.startsWith('/api/media/fal-queue/') || c.req.path.startsWith('/api/media/transcription')
      ? mediaUploadBodyPolicy(c, next)
      : mediaBodyPolicy(c, next),
  )
  app.use(
    '/api/media/*',
    (c, next) => (c.req.path.startsWith('/api/media/fal-queue/') ? next() : rateLimitMiddleware({
      redis: redis.commands,
      scope: 'entry-ip',
      limit: config.RATE_LIMIT_ENTRY_MAX,
      windowSeconds: config.RATE_LIMIT_ENTRY_WINDOW_SECONDS,
      subject: (c) => c.get('realIp'),
    })(c, next)),
  )
  // Media accepts two principals: a Better Auth user session, or an internal
  // service token (ai-drama 等内部服务) attributed to MEDIA_SERVICE_USER_ID —
  // 同一套目录、配额与用量账本。
  app.use('/api/media/*', async (c, next) => {
    const token = config.INTERNAL_SERVICE_TOKEN ?? config.MEDIA_SERVICE_TOKEN
    const authz = c.req.header('authorization')
    if (token && authz === `Bearer ${token}`) {
      c.set('auth', serviceAuth(config.MEDIA_SERVICE_USER_ID, 'media'))
      await next()
      return
    }
    await authenticate(auth)(c, next)
  })
  // 队列代理只服务内部主体（提交 + 轮询频率远高于媒体路由的按小时预算），
  // 不走媒体限流；滥用边界是令牌本身。
  app.use(
    '/api/media/*',
    (c, next) => (c.req.path.startsWith('/api/media/fal-queue/') ? next() : rateLimitMiddleware({
      redis: redis.commands,
      scope: 'media',
      limit: config.RATE_LIMIT_MEDIA_MAX,
      windowSeconds: config.RATE_LIMIT_MEDIA_WINDOW_SECONDS,
      subject: byAuthUserId,
    })(c, next)),
  )
  // The queue proxy mounts only when this deployment holds a fal key; without
  // one there is nothing to proxy and the route must not exist.
  if (config.FAL_KEY) {
    app.route('/api/media/fal-queue', createFalQueueProxyRoutes({ config, logger }))
  }
  app.route('/api/media', createMediaRoutes({ config, redis: redis.commands, logger, ...deps.media }))
  app.route('/api/media', createAudioRoutes({ config, redis: redis.commands, logger, ...deps.audio }))

  // 运营管理后台: same-origin form posts (urlencoded — NOT the JSON body
  // policy), session role check per request, entry-ip flood guard only.
  app.use(
    '/admin/*',
    rateLimitMiddleware({
      redis: redis.commands,
      scope: 'entry-ip',
      limit: config.RATE_LIMIT_ENTRY_MAX,
      windowSeconds: config.RATE_LIMIT_ENTRY_WINDOW_SECONDS,
      subject: (c) => c.get('realIp'),
    }),
  )
  app.route('/admin', createAdminRoutes({ config, db, redis: redis.commands, logger, auth, catalogStore }))

  app.route('/', createHealthRoutes(database, redis.commands))

  return { hono: app, auth, cloudComputers }
}
