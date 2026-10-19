import { Hono, type Context } from 'hono'
import { count, desc, eq, gte, ilike, or, sql } from 'drizzle-orm'
import type { RedisClientType } from 'redis'
import type { AppConfig } from '../../config/env.js'
import type { Db } from '../../db/client.js'
import { llmModels, llmRequestLog, mediaModels, user, userQuotas } from '../../db/schema.js'
import type { AppEnv } from '../../shared/context.js'
import { HttpApiError, assertSameOrigin } from '../../shared/http.js'
import type { Logger } from '../../shared/logger.js'
import type { Auth } from '../auth/auth.js'
import type { CatalogStore } from '../llm/catalog.js'
import { isMediaModelKind, type MediaCatalogStore } from '../media/catalog.js'
import { listRequestLog } from '../llm/requestLog.js'
import { adminExists, bootstrapFirstAdmin, consoleIdentity, saveModelEntry, validateBootstrapInput, type ConsoleIdentity } from './admin.shared.js'
import { registryList, registryProvider } from '../llm/registry.js'
import type { CredentialStore } from '../llm/credentials.js'

/**
 * 运营后台的 JSON API（/admin/api/*，供 /console 的 React SPA 使用）。
 * 与 HTML 控制台（admin.routes.ts）共用 admin.shared.ts 的身份与引导逻辑，
 * 差异只在表达层：JSON in/out + 状态码，表单闪条换成错误对象。
 * 写操作同样走 same-origin 断言（SPA 经同源或 dev 代理访问，浏览器必带 Origin）。
 */

export interface AdminApiDeps {
  config: AppConfig
  db: Db
  redis: RedisClientType
  logger: Logger
  auth: Auth
  catalogStore: CatalogStore
  mediaCatalogStore?: MediaCatalogStore
  credentialStore?: CredentialStore
  startedAt?: number
}

type Ctx = Context<AppEnv>

const MEDIA_PROVIDERS = ['fal', 'openai', 'google', 'xai', 'volcengine', 'minimax', 'aliyun', 'kling']

export function createAdminApiRoutes(deps: AdminApiDeps): Hono<AppEnv> {
  const { config, db, redis, logger, auth, catalogStore, credentialStore } = deps
  const mediaCatalogStore = deps.mediaCatalogStore
  const startedAt = deps.startedAt ?? Date.now()
  const origin = new URL(config.BETTER_AUTH_URL).origin

  function deny(c: Ctx): Response {
    return c.json({ code: 403, message: '需要管理员权限' }, 403)
  }

  /** Wraps a handler: fresh admin identity check, JSON errors with flashes on 400. */
  function gated(handler: (c: Ctx, who: ConsoleIdentity) => Promise<Response>): (c: Ctx) => Promise<Response> {
    return async (c) => {
      const who = await consoleIdentity(auth, c.req.raw.headers)
      if (who === null) return deny(c)
      try {
        if (c.req.method !== 'GET') assertSameOrigin(c, origin)
        return await handler(c, who)
      } catch (error) {
        if (error instanceof HttpApiError) throw error
        const message = error instanceof Error ? error.message : '操作失败'
        logger.warn({ err: error, userId: who.userId }, 'admin api action failed')
        return c.json({ code: 400, message }, 400)
      }
    }
  }

  function optionalInt(value: unknown, key: string, min: number): number | null {
    const raw = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
    if (raw === '') return null
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed) || parsed < min) throw new Error(`${key} 必须是 ≥ ${min} 的整数`)
    return parsed
  }

  /** gated() 包装会抹掉路径参数的字符串收窄，这里统一收口。 */
  function pathParam(c: Ctx, name: string): string {
    const value = c.req.param(name)
    if (value === undefined) throw new Error('缺少路径参数')
    return value
  }

  async function bodyJson(c: Ctx): Promise<Record<string, unknown>> {
    const body = await c.req.json().catch(() => null)
    if (body === null || typeof body !== 'object') throw new Error('请求体必须是 JSON 对象')
    return body as Record<string, unknown>
  }

  const routes = new Hono<AppEnv>()

  // ── 引导（免登录；仅在零管理员时开放）──
  routes.get('/api/bootstrap', async (c) => c.json({ code: 200, data: { initialized: await adminExists(db) }, message: 'success' }))

  routes.post('/api/setup', async (c) => {
    if (await adminExists(db)) return c.json({ code: 403, message: '系统已初始化，请直接登录' }, 403)
    try {
      assertSameOrigin(c, origin)
      const input = validateBootstrapInput(await bodyJson(c) as { email?: string; password?: string; confirm?: string })
      const result = await bootstrapFirstAdmin(db, auth, input)
      if (!result.ok) return c.json({ code: 409, message: result.error }, 409)
      const signed = await auth.api.signInEmail({ body: { email: input.email, password: input.password }, returnHeaders: true })
      const res = c.json({ code: 200, data: { userId: result.userId }, message: 'success' })
      for (const cookie of signed.headers.getSetCookie()) res.headers.append('set-cookie', cookie)
      logger.info({ userId: result.userId }, 'admin bootstrap completed via /admin/api/setup')
      return res
    } catch (error) {
      if (error instanceof HttpApiError) throw error
      const message = error instanceof Error ? error.message : '初始化失败'
      logger.warn({ err: error }, 'admin api bootstrap failed')
      return c.json({ code: 400, message }, 400)
    }
  })

  // models.dev 注册表（AI SDK 支持的 provider 与模型清单），供控制台下拉使用。
  routes.get('/api/registry', gated(async (c) => {
    return c.json({ code: 200, data: registryList(), message: 'success' })
  }))

  // ── 用户 ──
  routes.get('/api/users', gated(async (c) => {
    const query = (new URL(c.req.url).searchParams.get('q') ?? '').trim()
    const rows = await db
      .select()
      .from(user)
      .where(query ? or(ilike(user.email, `%${query}%`), ilike(user.name, `%${query}%`)) : undefined)
      .orderBy(desc(user.createdAt))
      .limit(200)
    return c.json({
      code: 200,
      data: rows.map((row) => ({
        id: row.id, email: row.email, name: row.name, role: row.role,
        banned: row.banned, banReason: row.banReason, createdAt: row.createdAt,
      })),
      message: 'success',
    })
  }))

  routes.get('/api/users/:id', gated(async (c) => {
    const targetId = pathParam(c, 'id')
    const rows = await db.select().from(user).where(eq(user.id, targetId)).limit(1)
    const target = rows[0]
    if (target === undefined) return c.json({ code: 404, message: '用户不存在' }, 404)
    const quotaRows = await db.select().from(userQuotas).where(eq(userQuotas.userId, targetId)).limit(1)
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '')
    const usage = await redis.hGetAll(`llm:usage:${targetId}:${day}`)
    const requests = await listRequestLog(db, { userId: targetId, limit: 20 })
    return c.json({
      code: 200,
      data: {
        user: {
          id: target.id, email: target.email, name: target.name, role: target.role,
          banned: target.banned, banReason: target.banReason, createdAt: target.createdAt,
        },
        quota: quotaRows[0] ?? null,
        todayTokens: Number(usage.total_tokens ?? 0),
        requests,
      },
      message: 'success',
    })
  }))

  routes.post('/api/users/:id/role', gated(async (c, who) => {
    const body = await bodyJson(c)
    const role = body.role === 'admin' ? 'admin' : 'user'
    const targetId = pathParam(c, 'id')
    if (targetId === who.userId && role !== 'admin') throw new Error('不能取消自己的管理员角色')
    await auth.api.setRole({ body: { userId: targetId, role }, headers: c.req.raw.headers })
    return c.json({ code: 200, data: { role }, message: 'success' })
  }))

  routes.post('/api/users/:id/ban', gated(async (c, who) => {
    const body = await bodyJson(c)
    const targetId = pathParam(c, 'id')
    if (targetId === who.userId) throw new Error('不能停用自己')
    await auth.api.banUser({
      body: { userId: targetId, banReason: typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined },
      headers: c.req.raw.headers,
    })
    return c.json({ code: 200, message: 'success' })
  }))

  routes.post('/api/users/:id/unban', gated(async (c) => {
    await auth.api.unbanUser({ body: { userId: pathParam(c, 'id') }, headers: c.req.raw.headers })
    return c.json({ code: 200, message: 'success' })
  }))

  routes.put('/api/users/:id/quota', gated(async (c) => {
    const body = await bodyJson(c)
    const targetId = pathParam(c, 'id')
    const allowlist = Array.isArray(body.modelAllowlist) ? body.modelAllowlist.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()) : null
    const values = {
      userId: targetId,
      dailyTokenLimit: optionalInt(body.dailyTokenLimit, 'dailyTokenLimit', 0),
      concurrencyLimit: optionalInt(body.concurrencyLimit, 'concurrencyLimit', 1),
      modelAllowlist: allowlist && allowlist.length ? JSON.stringify(allowlist) : null,
      updatedAt: new Date(),
    }
    await db.insert(userQuotas).values(values).onConflictDoUpdate({ target: userQuotas.userId, set: values })
    return c.json({ code: 200, message: 'success' })
  }))

  // ── 文本模型目录 ──
  routes.get('/api/models', gated(async (c) => {
    const rows = await db.select().from(llmModels).orderBy(llmModels.id)
    return c.json({ code: 200, data: rows, message: 'success' })
  }))

  routes.post('/api/models', gated(async (c) => {
    const body = await bodyJson(c)
    await saveModelEntry(
      { db, catalogStore, credentialStore },
      {
        id: String(body.id ?? ''), provider: String(body.provider ?? ''), model: String(body.model ?? ''),
        enabled: body.enabled !== false,
        displayName: typeof body.displayName === 'string' ? body.displayName : null,
        default: body.default === true,
        contextLength: (body.contextLength ?? null) as number | string | null,
        maxOutputTokens: (body.maxOutputTokens ?? null) as number | string | null,
        note: typeof body.note === 'string' ? body.note : null,
        baseURL: typeof body.baseURL === 'string' ? body.baseURL : null,
        apiKey: typeof body.apiKey === 'string' ? body.apiKey : null,
      },
    )
    return c.json({ code: 200, message: 'success' })
  }))

  // 保存 Provider 配置（凭证）：provider + 端点 + 密钥。baseURL 留空时取注册表默认端点。
  routes.post('/api/credentials', gated(async (c) => {
    if (!credentialStore) return c.json({ code: 501, message: '凭证存储未启用' }, 501)
    try {
      assertSameOrigin(c, origin)
      const body = await bodyJson(c)
      const provider = typeof body.provider === 'string' ? body.provider.trim().toLowerCase() : ''
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
      if (!provider) throw new Error('Provider 必填')
      if (!apiKey) throw new Error('API Key 必填')
      const explicit = typeof body.baseUrl === 'string' ? body.baseUrl.trim().replace(/\/+$/, '') : ''
      const baseUrl = explicit || registryProvider(provider)?.api?.replace(/\/+$/, '')
      if (!baseUrl) throw new Error('该 Provider 未收录默认端点，请填写 Base URL')
      await credentialStore.upsert(provider, baseUrl, apiKey)
      logger.info({ provider }, 'provider credential saved via console')
      return c.json({ code: 200, data: { provider, baseUrl }, message: 'success' })
    } catch (error) {
      if (error instanceof HttpApiError) throw error
      const message = error instanceof Error ? error.message : '保存失败'
      logger.warn({ err: error }, 'provider credential save failed')
      return c.json({ code: 400, message }, 400)
    }
  }))

  // 已保存凭证的掩码清单（只读；api_key 本体永不回传）。
  routes.get('/api/credentials', gated(async (c) => {
    if (!credentialStore) return c.json({ code: 200, data: [], message: 'success' })
    return c.json({ code: 200, data: await credentialStore.list(), message: 'success' })
  }))

  routes.post('/api/models/:id/toggle', gated(async (c) => {
    const id = pathParam(c, 'id')
    const rows = await db.select().from(llmModels).where(eq(llmModels.id, id)).limit(1)
    const current = rows[0]
    if (current === undefined) return c.json({ code: 404, message: '模型不存在' }, 404)
    await catalogStore.setEnabled(id, !current.enabled)
    return c.json({ code: 200, message: 'success' })
  }))

  routes.delete('/api/models/:id', gated(async (c) => {
    await catalogStore.remove(pathParam(c, 'id'))
    return c.json({ code: 200, message: 'success' })
  }))

  // ── 媒体模型目录 ──
  routes.get('/api/media-models', gated(async (c) => {
    const rows = await db.select().from(mediaModels).orderBy(mediaModels.kind, mediaModels.id)
    return c.json({ code: 200, data: rows, message: 'success' })
  }))

  routes.post('/api/media-models', gated(async (c) => {
    if (!mediaCatalogStore) return c.json({ code: 501, message: '媒体目录未启用' }, 501)
    const body = await bodyJson(c)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const kind = typeof body.kind === 'string' ? body.kind.trim() : ''
    const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!id || !model || !MEDIA_PROVIDERS.includes(provider) || !isMediaModelKind(kind)) {
      throw new Error('ID、类型、上游模型串与 Provider 均必填')
    }
    const maxImagesRaw = typeof body.maxImages === 'string' || typeof body.maxImages === 'number' ? String(body.maxImages).trim() : ''
    await mediaCatalogStore.upsert({
      id, kind, provider, model,
      enabled: body.enabled !== false,
      displayName: typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : null,
      maxImages: maxImagesRaw ? Number(maxImagesRaw) : null,
      note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null,
    })
    return c.json({ code: 200, message: 'success' })
  }))

  routes.post('/api/media-models/:id/toggle', gated(async (c) => {
    if (!mediaCatalogStore) return c.json({ code: 501, message: '媒体目录未启用' }, 501)
    const id = pathParam(c, 'id')
    const rows = await db.select().from(mediaModels).where(eq(mediaModels.id, id)).limit(1)
    const current = rows[0]
    if (current === undefined) return c.json({ code: 404, message: '媒体模型不存在' }, 404)
    await mediaCatalogStore.setEnabled(id, !current.enabled)
    return c.json({ code: 200, message: 'success' })
  }))

  routes.delete('/api/media-models/:id', gated(async (c) => {
    if (!mediaCatalogStore) return c.json({ code: 501, message: '媒体目录未启用' }, 501)
    await mediaCatalogStore.remove(pathParam(c, 'id'))
    return c.json({ code: 200, message: 'success' })
  }))

  // ── 请求日志 ──
  routes.get('/api/requests', gated(async (c) => {
    const statusParam = new URL(c.req.url).searchParams.get('status') ?? ''
    const status = statusParam === 'failed' || statusParam === 'rejected' || statusParam === 'complete' ? statusParam : undefined
    const rows = await listRequestLog(db, { status, limit: 200 })
    const emails = new Map<string, string>()
    for (const id of [...new Set(rows.map((row) => row.userId).filter((id): id is string => id !== null))]) {
      const found = await db.select({ email: user.email }).from(user).where(eq(user.id, id)).limit(1)
      if (found[0]) emails.set(id, found[0].email)
    }
    return c.json({
      code: 200,
      data: rows.map((row) => ({ ...row, email: row.userId ? (emails.get(row.userId) ?? null) : null })),
      message: 'success',
    })
  }))

  // ── 状态总览 ──
  routes.get('/api/status', gated(async (c) => {
    let dbOk = false
    let redisOk = false
    let activeStreams: number | null = null
    try {
      await db.execute(sql`select 1`)
      dbOk = true
    } catch {
      dbOk = false
    }
    try {
      redisOk = (await redis.ping()) === 'PONG'
      let active = 0
      for await (const keys of redis.scanIterator({ MATCH: 'llm:conc:*', COUNT: 200 })) {
        for (const key of keys) {
          const value = await redis.get(key)
          active += Math.max(0, Number(value ?? 0))
        }
      }
      activeStreams = active
    } catch {
      redisOk = false
    }
    const [userCounts] = await db
      .select({
        total: count(),
        banned: sql<number>`count(*) filter (where ${user.banned})`.mapWith(Number),
        admins: sql<number>`count(*) filter (where ${user.role} = 'admin')`.mapWith(Number),
      })
      .from(user)
    const [modelCounts] = await db
      .select({
        total: count(),
        enabled: sql<number>`count(*) filter (where ${llmModels.enabled})`.mapWith(Number),
      })
      .from(llmModels)
    const since = new Date(Date.now() - 24 * 3600 * 1000)
    const [dayStats] = await db
      .select({
        complete: sql<number>`count(*) filter (where ${llmRequestLog.status} = 'complete')`.mapWith(Number),
        failed: sql<number>`count(*) filter (where ${llmRequestLog.status} = 'failed')`.mapWith(Number),
        rejected: sql<number>`count(*) filter (where ${llmRequestLog.status} = 'rejected')`.mapWith(Number),
      })
      .from(llmRequestLog)
      .where(gte(llmRequestLog.createdAt, since))
    return c.json({
      code: 200,
      data: {
        dbOk,
        redisOk,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        activeStreams,
        totalUsers: userCounts?.total ?? 0,
        bannedUsers: userCounts?.banned ?? 0,
        adminUsers: userCounts?.admins ?? 0,
        modelsEnabled: modelCounts?.enabled ?? 0,
        modelsTotal: modelCounts?.total ?? 0,
        dayComplete: dayStats?.complete ?? 0,
        dayFailed: dayStats?.failed ?? 0,
        dayRejected: dayStats?.rejected ?? 0,
      },
      message: 'success',
    })
  }))

  return routes
}
