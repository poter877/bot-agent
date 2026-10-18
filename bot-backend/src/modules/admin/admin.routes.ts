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
import { MediaModelsPage } from './admin.views.js'
import { listRequestLog } from '../llm/requestLog.js'
import {
  ForbiddenPage,
  ModelsPage,
  RequestsPage,
  StatusPage,
  UserDetailPage,
  UsersPage,
  type AdminIdentity,
} from './admin.views.js'

/**
 * 运营管理后台（server-rendered at /admin, Chinese UI): users, 停用/启用,
 * roles, per-user quotas, model catalog CRUD, failed-request triage and
 * service status — so operators never hand-edit config files or SQL.
 *
 * Identity stays Better Auth's: pages check the session's role=admin (fresh,
 * cookie cache disabled); 停用/角色 changes go through the library's admin
 * API (auth.api.banUser deletes live sessions, so 停用即时生效) — the console
 * never UPDATEs library-owned columns directly. Form POSTs re-check Origin.
 */

export interface AdminDeps {
  config: AppConfig
  db: Db
  redis: RedisClientType
  logger: Logger
  auth: Auth
  catalogStore: CatalogStore
  mediaCatalogStore?: MediaCatalogStore
  startedAt?: number
}

type Ctx = Context<AppEnv>

function flash(c: Ctx): { ok?: string; err?: string } {
  const url = new URL(c.req.url)
  return { ok: url.searchParams.get('ok') ?? undefined, err: url.searchParams.get('err') ?? undefined }
}

function redirectTo(c: Ctx, path: string, message: { ok?: string; err?: string }): Response {
  const url = new URL(path, c.req.url)
  if (message.ok) url.searchParams.set('ok', message.ok)
  if (message.err) url.searchParams.set('err', message.err)
  return new Response(null, { status: 303, headers: { location: `${url.pathname}${url.search}` } })
}

async function formFields(c: Ctx): Promise<Record<string, string>> {
  const raw = await c.req.parseBody()
  const fields: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') fields[key] = value
  }
  return fields
}

function pathParam(c: Ctx, name: string): string {
  const value = c.req.param(name)
  if (value === undefined) throw new Error('缺少路径参数')
  return value
}

function optionalInt(fields: Record<string, string>, key: string, min: number): number | null {
  const raw = (fields[key] ?? '').trim()
  if (raw === '') return null
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${key} 必须是 ≥ ${min} 的整数`)
  }
  return value
}

export function createAdminRoutes(deps: AdminDeps): Hono<AppEnv> {
  const { config, db, redis, logger, auth, catalogStore } = deps
  const mediaCatalogStore = deps.mediaCatalogStore
  const startedAt = deps.startedAt ?? Date.now()
  const origin = new URL(config.BETTER_AUTH_URL).origin

  /** Fresh role check on every console request (cookie cache disabled). */
  async function identity(c: Ctx): Promise<AdminIdentity | null> {
    let result: { user?: { id?: string; email?: string; role?: string } } | null
    try {
      result = (await auth.api.getSession({
        headers: c.req.raw.headers,
        query: { disableCookieCache: true },
      })) as unknown as { user?: { id?: string; email?: string; role?: string } } | null
    } catch {
      return null
    }
    const sessionUser = result?.user
    if (!sessionUser?.id || sessionUser.role !== 'admin') return null
    return { userId: sessionUser.id, email: sessionUser.email ?? '' }
  }

  async function page(c: Ctx, render: (identity: AdminIdentity) => Promise<string>): Promise<Response> {
    const who = await identity(c)
    if (who === null) {
      return c.html(ForbiddenPage({ identity: null }).toString(), 403)
    }
    return c.html(await render(who))
  }

  /** Wrap a mutating handler: identity + Origin check + error flash. */
  function action(handler: (c: Ctx, identity: AdminIdentity) => Promise<Response>): (c: Ctx) => Promise<Response> {
    return async (c) => {
      const who = await identity(c)
      if (who === null) {
        return c.html(ForbiddenPage({ identity: null }).toString(), 403)
      }
      try {
        assertSameOrigin(c, origin)
        return await handler(c, who)
      } catch (error) {
        // CSRF rejections stay protocol errors; only operator-facing mistakes
        // (plain Errors) become a redirect flash.
        if (error instanceof HttpApiError) throw error
        const message = error instanceof Error ? error.message : '操作失败'
        logger.warn({ err: error, userId: who.userId }, 'admin action failed')
        return redirectTo(c, new URL(c.req.url).pathname, { err: message })
      }
    }
  }

  const routes = new Hono<AppEnv>()

  routes.get('/', async (c) =>
    page(c, async (who) => {
      const query = (new URL(c.req.url).searchParams.get('q') ?? '').trim()
      const rows = await db
        .select()
        .from(user)
        .where(query ? or(ilike(user.email, `%${query}%`), ilike(user.name, `%${query}%`)) : undefined)
        .orderBy(desc(user.createdAt))
        .limit(200)
      return UsersPage({
        identity: who,
        users: rows.map((row) => ({
          id: row.id,
          email: row.email,
          name: row.name,
          role: row.role,
          banned: row.banned,
          banReason: row.banReason,
          createdAt: row.createdAt,
        })),
        query,
        ...flash(c),
      }).toString()
    }),
  )

  routes.post('/users/:id/ban', action(async (c, who) => {
    const fields = await formFields(c)
    const targetId = pathParam(c, 'id')
    if (targetId === who.userId) throw new Error('不能停用自己')
    await auth.api.banUser({
      body: { userId: targetId, banReason: (fields.reason ?? '').trim() || undefined },
      headers: c.req.raw.headers,
    })
    return redirectTo(c, '/admin', { ok: '账号已停用，其全部会话已吊销。' })
  }))

  routes.post('/users/:id/unban', action(async (c) => {
    await auth.api.unbanUser({ body: { userId: pathParam(c, 'id') }, headers: c.req.raw.headers })
    return redirectTo(c, '/admin', { ok: '账号已启用。' })
  }))

  routes.post('/users/:id/role', action(async (c, who) => {
    const fields = await formFields(c)
    const role = fields.role === 'admin' ? 'admin' : 'user'
    const targetId = pathParam(c, 'id')
    if (targetId === who.userId && role !== 'admin') throw new Error('不能取消自己的管理员角色')
    await auth.api.setRole({ body: { userId: targetId, role }, headers: c.req.raw.headers })
    return redirectTo(c, '/admin', { ok: `角色已更新为 ${role}。` })
  }))

  routes.get('/users/:id', async (c) =>
    page(c, async (who) => {
      const targetId = pathParam(c, 'id')
      const rows = await db.select().from(user).where(eq(user.id, targetId)).limit(1)
      const target = rows[0]
      if (target === undefined) return ForbiddenPage({ identity: who }).toString()
      const quotaRows = await db.select().from(userQuotas).where(eq(userQuotas.userId, targetId)).limit(1)
      const day = new Date().toISOString().slice(0, 10).replaceAll('-', '')
      const usage = await redis.hGetAll(`llm:usage:${targetId}:${day}`)
      const requests = await listRequestLog(db, { userId: targetId, limit: 20 })
      return UserDetailPage({
        identity: who,
        user: {
          id: target.id,
          email: target.email,
          name: target.name,
          role: target.role,
          banned: target.banned,
          banReason: target.banReason,
          createdAt: target.createdAt,
        },
        quota: quotaRows[0] ?? null,
        todayTokens: Number(usage.total_tokens ?? 0),
        requests,
        ...flash(c),
      }).toString()
    }),
  )

  routes.post('/users/:id/quota', action(async (c) => {
    const fields = await formFields(c)
    const targetId = pathParam(c, 'id')
    const allowlistRaw = (fields.model_allowlist ?? '').trim()
    const values = {
      userId: targetId,
      dailyTokenLimit: optionalInt(fields, 'daily_token_limit', 0),
      concurrencyLimit: optionalInt(fields, 'concurrency_limit', 1),
      modelAllowlist: allowlistRaw
        ? JSON.stringify(allowlistRaw.split(',').map((item) => item.trim()).filter(Boolean))
        : null,
      updatedAt: new Date(),
    }
    await db.insert(userQuotas).values(values).onConflictDoUpdate({ target: userQuotas.userId, set: values })
    return redirectTo(c, `/admin/users/${targetId}`, { ok: '额度已保存（15 秒内对全部实例生效）。' })
  }))

  routes.get('/models', async (c) =>
    page(c, async (who) => {
      const url = new URL(c.req.url)
      const rows = await db.select().from(llmModels).orderBy(llmModels.id)
      return ModelsPage({
        identity: who,
        models: rows,
        editId: url.searchParams.get('edit'),
        ...flash(c),
      }).toString()
    }),
  )

  routes.post('/models', action(async (c) => {
    const fields = await formFields(c)
    const id = (fields.id ?? '').trim()
    const provider = (fields.provider ?? '').trim()
    const model = (fields.model ?? '').trim()
    if (!id || !model || !['openai', 'anthropic', 'google'].includes(provider)) {
      throw new Error('模型 ID、上游模型串与 Provider 均必填')
    }
    await catalogStore.upsert({
      id,
      provider,
      model,
      enabled: fields.enabled === 'on',
      displayName: (fields.display_name ?? '').trim() || null,
      default: fields.is_default === 'on',
      contextLength: optionalInt(fields, 'context_length', 1),
      maxOutputTokens: optionalInt(fields, 'max_output_tokens', 1),
      note: (fields.note ?? '').trim() || null,
    })
    if (fields.is_default === 'on') {
      // Single-default invariant: the newest default wins.
      await db.update(llmModels).set({ isDefault: false }).where(sql`${llmModels.id} <> ${id} and ${llmModels.isDefault}`)
    }
    return redirectTo(c, '/admin/models', { ok: `模型 ${id} 已保存（目录缓存 15 秒内刷新）。` })
  }))

  routes.post('/models/:id/toggle', action(async (c) => {
    const id = pathParam(c, 'id')
    const rows = await db.select().from(llmModels).where(eq(llmModels.id, id)).limit(1)
    const current = rows[0]
    if (current === undefined) throw new Error('模型不存在')
    await catalogStore.setEnabled(id, !current.enabled)
    return redirectTo(c, '/admin/models', { ok: `模型 ${id} 已${current.enabled ? '停用' : '启用'}。` })
  }))

  routes.post('/models/:id/delete', action(async (c) => {
    const id = pathParam(c, 'id')
    await catalogStore.remove(id)
    return redirectTo(c, '/admin/models', { ok: `模型 ${id} 已删除。` })
  }))

  routes.get('/media', async (c) =>
    page(c, async (who) => {
      const url = new URL(c.req.url)
      const rows = await db.select().from(mediaModels).orderBy(mediaModels.kind, mediaModels.id)
      return MediaModelsPage({
        identity: who,
        models: rows,
        editId: url.searchParams.get('edit'),
        ...flash(c),
      }).toString()
    }),
  )

  routes.post('/media', action(async (c) => {
    const fields = await formFields(c)
    const id = (fields.id ?? '').trim()
    const kind = (fields.kind ?? '').trim()
    const provider = (fields.provider ?? '').trim()
    const model = (fields.model ?? '').trim()
    const providers = ['fal', 'openai', 'google', 'xai', 'volcengine', 'minimax', 'aliyun', 'kling']
    if (!id || !model || !providers.includes(provider) || !isMediaModelKind(kind)) {
      throw new Error('ID、类型、上游模型串与 Provider 均必填')
    }
    const maxImagesRaw = (fields.max_images ?? '').trim()
    await mediaCatalogStore!.upsert({
      id, kind, provider, model,
      enabled: fields.enabled === 'on',
      displayName: (fields.display_name ?? '').trim() || null,
      maxImages: maxImagesRaw ? Number(maxImagesRaw) : null,
      note: (fields.note ?? '').trim() || null,
    })
    return redirectTo(c, '/admin/media', { ok: `媒体模型 ${id} 已保存（目录缓存 15 秒内刷新）。` })
  }))

  routes.post('/media/:id/toggle', action(async (c) => {
    const id = pathParam(c, 'id')
    const rows = await db.select().from(mediaModels).where(eq(mediaModels.id, id)).limit(1)
    const current = rows[0]
    if (current === undefined) throw new Error('媒体模型不存在')
    await mediaCatalogStore!.setEnabled(id, !current.enabled)
    return redirectTo(c, '/admin/media', { ok: `媒体模型 ${id} 已${current.enabled ? '停用' : '启用'}。` })
  }))

  routes.post('/media/:id/delete', action(async (c) => {
    const id = pathParam(c, 'id')
    await mediaCatalogStore!.remove(id)
    return redirectTo(c, '/admin/media', { ok: `媒体模型 ${id} 已删除。` })
  }))

  routes.get('/requests', async (c) =>
    page(c, async (who) => {
      const statusParam = new URL(c.req.url).searchParams.get('status') ?? ''
      const status = statusParam === 'failed' || statusParam === 'rejected' || statusParam === 'complete' ? statusParam : undefined
      const rows = await listRequestLog(db, { status, limit: 200 })
      const emails = new Map<string, string>()
      for (const id of [...new Set(rows.map((row) => row.userId).filter((id): id is string => id !== null))]) {
        const found = await db.select({ email: user.email }).from(user).where(eq(user.id, id)).limit(1)
        if (found[0]) emails.set(id, found[0].email)
      }
      return RequestsPage({
        identity: who,
        rows: rows.map((row) => ({ ...row, email: row.userId ? (emails.get(row.userId) ?? null) : null })),
        status: statusParam,
        ...flash(c),
      }).toString()
    }),
  )

  routes.get('/status', async (c) =>
    page(c, async (who) => {
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
      return StatusPage({
        identity: who,
        stats: {
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
        ...flash(c),
      }).toString()
    }),
  )

  return routes
}
