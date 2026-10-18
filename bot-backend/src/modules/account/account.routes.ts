import { Hono, type Context } from 'hono'
import { and, count, desc, eq, gte, sql } from 'drizzle-orm'
import type { RedisClientType } from 'redis'
import type { Db } from '../../db/client.js'
import { llmRequestLog, session as sessionTable } from '../../db/schema.js'
import type { AppEnv } from '../../shared/context.js'
import { HttpApiError, assertSameOrigin } from '../../shared/http.js'
import type { Logger } from '../../shared/logger.js'
import type { Auth } from '../auth/auth.js'
import { approveDeviceCode, loadApprovableDeviceCode } from './device.js'
import { createApiToken, listApiTokens, revokeApiToken } from './tokens.js'
import {
  DeviceApprovePage,
  LoginPage,
  OverviewPage,
  PasswordPage,
  SessionsPage,
  TokenCreatedPage,
  TokensPage,
  type AccountIdentity,
  type ModelUsageRow,
} from './account.views.js'

/**
 * 用户门户（/account，普通用户，中文界面）：用量总览、活跃会话、API 令牌、
 * 修改密码、设备登录批准。与运营后台同一套 form-post + redirect flash 模式。
 *
 * 身份即 Better Auth 会话（每次请求 fresh 校验，cookie 缓存关闭）；所有
 * 写操作复检 Origin。令牌创建页直接渲染明文（不走 redirect，避免 URL 泄漏）。
 * 密码与会话生命周期经 auth.api（changePassword / revokeSession）——绝不
 * 直接改库中库属列。
 */

export interface AccountDeps {
  config: { BETTER_AUTH_URL: string }
  db: Db
  redis: RedisClientType
  logger: Logger
  auth: Auth
}

interface PortalIdentity extends AccountIdentity {
  sessionId: string
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

/** better-auth 的 APIError → 面向用户的 flash 文案。 */
function authErrorMessage(error: unknown, fallback: string): string {
  const body = (error as { body?: { message?: unknown } } | null)?.body
  if (typeof body?.message === 'string' && body.message.trim() !== '') return body.message
  if (error instanceof Error && error.message.trim() !== '') return error.message
  return fallback
}

export function createAccountRoutes(deps: AccountDeps): Hono<AppEnv> {
  const { db, redis, logger, auth } = deps
  const origin = new URL(deps.config.BETTER_AUTH_URL).origin

  async function identity(c: Ctx): Promise<PortalIdentity | null> {
    let result: { session?: { id?: string }; user?: { id?: string; email?: string; name?: string } } | null
    try {
      result = (await auth.api.getSession({
        headers: c.req.raw.headers,
        query: { disableCookieCache: true },
      })) as unknown as { session?: { id?: string }; user?: { id?: string; email?: string; name?: string } } | null
    } catch {
      return null
    }
    const user = result?.user
    if (!result?.session?.id || !user?.id) return null
    return { userId: user.id, email: user.email ?? '', name: user.name ?? '', sessionId: result.session.id }
  }

  /** Page gate: 401 + login page for anonymous visitors (低频页面，无限流需求). */
  async function page(c: Ctx, render: (identity: PortalIdentity) => Promise<string>): Promise<Response> {
    const who = await identity(c)
    if (who === null) {
      return c.html(LoginPage({ identity: null }).toString(), 401)
    }
    return c.html(await render(who))
  }

  function action(handler: (c: Ctx, identity: PortalIdentity) => Promise<Response>): (c: Ctx) => Promise<Response> {
    return async (c) => {
      const who = await identity(c)
      if (who === null) {
        return c.html(LoginPage({ identity: null }).toString(), 401)
      }
      try {
        assertSameOrigin(c, origin)
        return await handler(c, who)
      } catch (error) {
        if (error instanceof HttpApiError) throw error
        const message = error instanceof Error && error.message !== '' ? error.message : '操作失败'
        logger.warn({ err: error, userId: who.userId }, 'account action failed')
        return redirectTo(c, new URL(c.req.url).pathname, { err: message })
      }
    }
  }

  const routes = new Hono<AppEnv>()

  // ── 用量总览：llm_request_log 近 7 天聚合 + Redis 媒体用量 ──
  routes.get('/', async (c) =>
    page(c, async (who) => {
      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000)
      const scope = and(eq(llmRequestLog.userId, who.userId), gte(llmRequestLog.createdAt, since))
      const [totals] = await db
        .select({
          requests: count(),
          complete: sql<number>`count(*) filter (where ${llmRequestLog.status} = 'complete')`.mapWith(Number),
          failed: sql<number>`count(*) filter (where ${llmRequestLog.status} = 'failed')`.mapWith(Number),
          rejected: sql<number>`count(*) filter (where ${llmRequestLog.status} = 'rejected')`.mapWith(Number),
          inputTokens: sql<number>`coalesce(sum(${llmRequestLog.inputTokens}), 0)`.mapWith(Number),
          outputTokens: sql<number>`coalesce(sum(${llmRequestLog.outputTokens}), 0)`.mapWith(Number),
          totalTokens: sql<number>`coalesce(sum(${llmRequestLog.totalTokens}), 0)`.mapWith(Number),
        })
        .from(llmRequestLog)
        .where(scope)
      const topModels = await db
        .select({
          modelId: llmRequestLog.modelId,
          requests: count(),
          totalTokens: sql<number>`coalesce(sum(${llmRequestLog.totalTokens}), 0)`.mapWith(Number),
        })
        .from(llmRequestLog)
        .where(scope)
        .groupBy(llmRequestLog.modelId)
        .orderBy(desc(count()))
        .limit(8)
      // 媒体生成只有 Redis 账本（media:usage:<uid>:<YYYY-MM-DD>，保存 90 天）：
      // 逐日读最近 7 天的哈希，requests 字段与 model:<id> 计数分别累计。
      const perModel = new Map<string, number>()
      let mediaRequests = 0
      for (let offset = 0; offset < 7; offset += 1) {
        const day = new Date(Date.now() - offset * 24 * 3600 * 1000).toISOString().slice(0, 10)
        const usage = await redis.hGetAll(`media:usage:${who.userId}:${day}`).catch(() => ({}) as Record<string, string>)
        for (const [field, value] of Object.entries(usage)) {
          if (field === 'requests') {
            mediaRequests += Number(value) || 0
          } else if (field.startsWith('model:')) {
            const modelId = field.slice('model:'.length)
            perModel.set(modelId, (perModel.get(modelId) ?? 0) + (Number(value) || 0))
          }
        }
      }
      return OverviewPage({
        identity: who,
        llm: {
          requests: totals?.requests ?? 0,
          complete: totals?.complete ?? 0,
          failed: totals?.failed ?? 0,
          rejected: totals?.rejected ?? 0,
          inputTokens: totals?.inputTokens ?? 0,
          outputTokens: totals?.outputTokens ?? 0,
          totalTokens: totals?.totalTokens ?? 0,
        },
        topModels: topModels as ModelUsageRow[],
        media: {
          requests: mediaRequests,
          perModel: [...perModel.entries()].map(([modelId, requests]) => ({ modelId, requests })),
        },
        ...flash(c),
      }).toString()
    }),
  )

  // ── 活跃会话 ──
  routes.get('/sessions', async (c) =>
    page(c, async (who) => {
      const rows = await db
        .select()
        .from(sessionTable)
        .where(eq(sessionTable.userId, who.userId))
        .orderBy(desc(sessionTable.createdAt))
        .limit(50)
      return SessionsPage({
        identity: who,
        sessions: rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          ipAddress: row.ipAddress,
          userAgent: row.userAgent,
          current: row.id === who.sessionId,
        })),
        ...flash(c),
      }).toString()
    }),
  )

  routes.post('/sessions/:id/revoke', action(async (c, who) => {
    if (c.req.param('id') === who.sessionId) {
      return redirectTo(c, '/account/sessions', { err: '不能撤销当前会话；如需下线请直接退出登录。' })
    }
    const rows = await db
      .select({ token: sessionTable.token })
      .from(sessionTable)
      .where(and(eq(sessionTable.id, c.req.param('id')!), eq(sessionTable.userId, who.userId)))
      .limit(1)
    if (rows[0] === undefined) {
      return redirectTo(c, '/account/sessions', { err: '会话不存在。' })
    }
    // 经库的 revokeSession：同一处也负责会话 cookie 失效的语义。
    await auth.api.revokeSession({ body: { token: rows[0].token }, headers: c.req.raw.headers })
    return redirectTo(c, '/account/sessions', { ok: '会话已撤销，对应设备需重新登录。' })
  }))

  // ── API 令牌（门户视图；JSON CRUD 在 /api/account/tokens） ──
  routes.get('/tokens', async (c) =>
    page(c, async (who) => {
      const rows = await listApiTokens(db, who.userId)
      return TokensPage({ identity: who, tokens: rows, ...flash(c) }).toString()
    }),
  )

  // 创建后直接渲染明文（一次性），不走 redirect —— 明文绝不进 URL。
  routes.post('/tokens', action(async (c, who) => {
    const fields = await formFields(c)
    const name = (fields.name ?? '').trim()
    if (name === '') {
      return redirectTo(c, '/account/tokens', { err: '请填写令牌名称。' })
    }
    if (name.length > 64) {
      return redirectTo(c, '/account/tokens', { err: '名称最长 64 个字符。' })
    }
    try {
      const created = await createApiToken(db, who.userId, name)
      return c.html(TokenCreatedPage({ identity: who, name, plaintext: created.plaintext }).toString())
    } catch (error) {
      return redirectTo(c, '/account/tokens', { err: authErrorMessage(error, '令牌创建失败。') })
    }
  }))

  routes.post('/tokens/:id/revoke', action(async (c, who) => {
    try {
      await revokeApiToken(db, who.userId, c.req.param('id')!)
    } catch (error) {
      return redirectTo(c, '/account/tokens', { err: authErrorMessage(error, '令牌不存在。') })
    }
    return redirectTo(c, '/account/tokens', { ok: '令牌已撤销。' })
  }))

  // ── 修改密码（Better Auth changePassword API） ──
  routes.get('/password', async (c) =>
    page(c, async (who) => PasswordPage({ identity: who, ...flash(c) }).toString()),
  )

  routes.post('/password', action(async (c, who) => {
    const fields = await formFields(c)
    const currentPassword = fields.current_password ?? ''
    const newPassword = fields.new_password ?? ''
    if (newPassword.length < 8) {
      return redirectTo(c, '/account/password', { err: '新密码至少 8 位。' })
    }
    if (newPassword !== (fields.confirm_password ?? '')) {
      return redirectTo(c, '/account/password', { err: '两次输入的新密码不一致。' })
    }
    try {
      await auth.api.changePassword({
        body: {
          currentPassword,
          newPassword,
          revokeOtherSessions: fields.revoke_other_sessions === 'on',
        },
        headers: c.req.raw.headers,
      })
    } catch (error) {
      return redirectTo(c, '/account/password', { err: authErrorMessage(error, '密码修改失败。') })
    }
    return redirectTo(c, '/account/password', {
      ok: fields.revoke_other_sessions === 'on'
        ? '密码已修改，其他会话已全部撤销。'
        : '密码已修改。',
    })
  }))

  // ── 设备登录批准页 ──
  routes.get('/device', async (c) =>
    page(c, async (who) => {
      const code = (new URL(c.req.url).searchParams.get('code') ?? '').trim()
      const row = code === '' ? null : await loadApprovableDeviceCode(db, code)
      const state = row === null
        ? 'unknown'
        : row.consumedAt !== null
          ? 'used'
          : row.approvedAt !== null
            ? 'approved'
            : 'pending'
      return DeviceApprovePage({
        identity: who,
        code,
        userAgent: row?.userAgent ?? null,
        expiresAt: row?.expiresAt ?? null,
        state,
        ...flash(c),
      }).toString()
    }),
  )

  routes.post('/device/approve', action(async (c, who) => {
    const fields = await formFields(c)
    const code = (fields.code ?? '').trim()
    try {
      await approveDeviceCode(db, who.userId, code)
    } catch (error) {
      return redirectTo(c, `/account/device?code=${encodeURIComponent(code)}`, {
        err: authErrorMessage(error, '设备码无效或已过期。'),
      })
    }
    return redirectTo(c, `/account/device?code=${encodeURIComponent(code)}`, { ok: '已批准，终端即可领取令牌。' })
  }))

  return routes
}
