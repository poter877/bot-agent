import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Database } from './db/client.js'
import type { RedisConnections } from './redis/client.js'
import type { Config } from './config/env.js'
import type { Logger } from './shared/logger.js'
import type { AppEnv } from './shared/context.js'
import { HttpApiError } from './shared/http.js'
import { serverRequestId } from './middleware/requestId.js'
import { correlationIdMiddleware } from './middleware/correlationId.js'
import { accessLogMiddleware } from './middleware/accessLog.js'
import { securityMiddleware } from './middleware/security.js'
import { realIpMiddleware } from './middleware/realIp.js'
import { mountAccount } from './modules/account/mount.js'
import { mountToolsGateway } from './modules/tools/mount.js'
import { principalMiddleware } from './middleware/principal.js'
import { processingTimeout, scopedProcessingTimeout } from './middleware/timeout.js'
import { bodyPolicyMiddleware } from './middleware/bodyPolicy.js'
import { byAuthUserId, accountBucketKey, rateLimitMiddleware, enforceBucket } from './middleware/rateLimit.js'
import { authenticate } from './middleware/auth.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { createAuth, type Auth } from './modules/auth/auth.js'
import { createUsersRoutes } from './modules/users/users.routes.js'
import { createHealthRoutes } from './modules/health/health.routes.js'
import { createLlmRoutes } from './modules/llm/llm.routes.js'
import { createMediaRoutes } from './modules/media/media.routes.js'
import { createAudioRoutes } from './modules/media/audio.routes.js'
import type { MediaCatalogEntry } from './modules/media/catalog.js'
import { CatalogStore, parseModelCatalog } from './modules/llm/catalog.js'
import { CredentialStore } from './modules/llm/credentials.js'
import { DEFAULT_AUDIO_CATALOG, MediaCatalogStore, parseMediaCatalog, type MediaModelKind } from './modules/media/catalog.js'
import { createAdminRoutes } from './modules/admin/admin.routes.js'
import { createAdminApiRoutes } from './modules/admin/admin.api.js'
import { serveStatic } from '@hono/node-server/serve-static'
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
 * check. The API trees (/api/llm, /api/media, /api/tools) instead settle
 * identity through one principal ladder (middleware/principal.ts: service
 * token → bat_ user token → session). The doc's common request boundary
 * still applies to every tree:
 *
 *   request id -> security headers -> CORS -> real IP -> principal (API
 *   trees) -> processing budget (scoped trees settle their own; the global
 *   mount defers) -> body policy -> entry rate limit -> (per-account buckets
 *   on sign-in/sign-up) -> Better Auth handler / authenticate (getSession,
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
  const credentialStore = new CredentialStore(db)
  // The media directory: env image/video catalogs + the audio defaults seed an
  // empty media_models table once; the console owns it afterwards.
  const mediaCatalogStore = new MediaCatalogStore(db, [
    ...parseMediaCatalog(config.LLM_IMAGE_CATALOG, 'image').map((entry) => ({ ...entry, kind: 'image' as MediaModelKind })),
    ...parseMediaCatalog(config.LLM_VIDEO_CATALOG, 'video').map((entry) => ({ ...entry, kind: 'video' as MediaModelKind })),
    ...DEFAULT_AUDIO_CATALOG,
  ])

  const app = new Hono<AppEnv>()

  app.onError(errorHandler(logger))
  app.notFound(notFoundHandler())

  app.use(serverRequestId())
  app.use(correlationIdMiddleware())
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
  // One identity ladder for the API trees (/api/llm, /api/media, /api/tools):
  // service token → bat_ user token → Better Auth session. It only settles
  // identity — trees enforce presence via requireAuthContext, every other
  // tree (auth, portal, admin, /v1) keeps its own admission story. Mounted
  // ahead of the trees so per-user limiters and routes see the principal.
  app.use(principalMiddleware({ config, db: database.db, auth }))
  // Media generation (video especially) legitimately runs for minutes: the
  // tree settles its own budget so the global mount below defers to it
  // instead of racing it with the shorter 10s timer.
  app.use('/api/media/*', scopedProcessingTimeout(config.MEDIA_REQUEST_TIMEOUT_MS))
  // Managed tool gateway (search today): own short budget, same settle-then-defer
  // contract, mounted before the global budget.
  mountToolsGateway(app, { config, redis, logger })
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

  // User self-service (API tokens, device-code flow, /account portal) mounts its
  // trees and the bat_ bearer check ahead of the wildcard handler below.
  mountAccount(app, { config, db, redis: redis.commands, logger, auth })

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
  // 凭证传递方式沿用账号后端的实现约定) with their own per-user request budget;
  // the principal middleware above settles sessions, bat_ tokens and internal
  // service principals (ai-drama 的 mastra agents) alike.
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
  app.route('/api/llm', createLlmRoutes({ config, db, redis: redis.commands, logger, catalogStore, credentialStore, ...deps.llm }))

  // Media generation (image/video/audio/queue): same Better Auth session or
  // internal service token, own per-user request budget, generation errors
  // answer as 502. The queue and video routes carry submit payloads with
  // inline data URIs (kling image2video first frames) and the transcription
  // route takes multipart audio — all three get the stream-sized body budget
  // (and, for transcription, the multipart allowance) instead of the small
  // JSON-only media one.
  const mediaBodyPolicy = bodyPolicyMiddleware(config.MEDIA_BODY_LIMIT_BYTES)
  const mediaUploadBodyPolicy = bodyPolicyMiddleware(config.LLM_STREAM_BODY_LIMIT_BYTES, ['application/json', 'multipart/form-data'])
  app.use('/api/media/*', (c, next) =>
    c.req.path.startsWith('/api/media/queue') ||
    c.req.path.startsWith('/api/media/video') ||
    c.req.path.startsWith('/api/media/transcription')
      ? mediaUploadBodyPolicy(c, next)
      : mediaBodyPolicy(c, next),
  )
  app.use(
    '/api/media/*',
    rateLimitMiddleware({
      redis: redis.commands,
      scope: 'entry-ip',
      limit: config.RATE_LIMIT_ENTRY_MAX,
      windowSeconds: config.RATE_LIMIT_ENTRY_WINDOW_SECONDS,
      subject: (c) => c.get('realIp'),
    }),
  )
  // 队列端点由公司侧内化轮询（一次请求 = 一次生成），与媒体路由同享按小时
  // 预算；服务令牌门在路由内收紧为仅内部主体。身份（会话 / bat_ / 服务令牌）
  // 由上方 principal 中间件统一判定。
  app.use(
    '/api/media/*',
    rateLimitMiddleware({
      redis: redis.commands,
      scope: 'media',
      limit: config.RATE_LIMIT_MEDIA_MAX,
      windowSeconds: config.RATE_LIMIT_MEDIA_WINDOW_SECONDS,
      subject: byAuthUserId,
    }),
  )
  app.route('/api/media', createMediaRoutes({ config, db, redis: redis.commands, logger, catalogStore: mediaCatalogStore, ...deps.media }))
  app.route('/api/media', createAudioRoutes({ config, db, redis: redis.commands, logger, catalogStore: mediaCatalogStore, ...deps.audio }))

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
  // JSON API（/admin/api/*）先于 HTML 控制台挂载；两者共用 admin.shared.ts。
  app.route('/admin', createAdminApiRoutes({ config, db, redis: redis.commands, logger, auth, catalogStore, mediaCatalogStore, credentialStore }))
  app.route('/admin', createAdminRoutes({ config, db, redis: redis.commands, logger, auth, catalogStore, mediaCatalogStore, credentialStore }))

  // 管理台 SPA（bot-backend/admin 的构建产物）：生产同源挂在 /console，
  // 开发时由 vite dev server（30177）代理到本服务。根路径留给视频工厂 SPA（drama 兜底）。
  app.use('/console/*', serveStatic({ root: './admin/dist', rewriteRequestPath: (p) => p.replace(/^\/console/, '') || '/' }))
  app.get('/console/*', serveStatic({ root: './admin/dist', rewriteRequestPath: () => '/index.html' }))
  app.get('/console', serveStatic({ root: './admin/dist', path: '/index.html' }))


  app.route('/', createHealthRoutes(database, redis.commands))
  // 视频工厂子应用（/api/v1、/mcp、/static）— 与宿主同会话；本地作业（ffmpeg/sharp）与
  // 媒体落盘（DRAMA_DATA_ROOT → ai-drama/data）跟随本进程所在机器。drama 子树由
  // tsconfig.drama.json 按原严格度独立编译，此处仅运行时挂载（顶层 await 动态导入）。
  // 必须挂在宿主全部路由之后：drama 的 SPA 兜底 get('*') 不得抢 /admin、/api、/console。
  // 非字面量 specifier：TS 不追踪该动态导入（drama 子树独立编译），Node 运行时照常解析
  const dramaAppModule = './drama/app.js' as string
  const drama = (await import(dramaAppModule)) as unknown as {
    createDramaApp: (auth: Auth) => Hono
    recoverDrama: () => Promise<void>
  }
  app.route('/', drama.createDramaApp(auth))
  void drama.recoverDrama().catch((err) => logger.warn({ err }, 'drama recovery failed'))


  return { hono: app, auth, cloudComputers }
}
