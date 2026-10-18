import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { llmRequestLog } from '../src/db/schema.js'
import {
  cookieFrom,
  createTestApp,
  flushRateLimits,
  jsonRequest,
  registerUser,
  signIn,
  truncateAll,
  uniqueEmail,
  type RegisteredUser,
  type TestApp,
} from './helpers.js'

/**
 * 用户门户 /account（普通用户）：登录可访问、未登录 401；用量聚合与造数
 * 一致（llm_request_log 近 7 天 + Redis 媒体账本）；活跃会话撤销；API 令牌
 * 创建页明文只显示一次；修改密码走 Better Auth changePassword。
 */

const PASSWORD = 'correct-horse-battery'
const BASE = 'http://127.0.0.1:3100'

async function formPost(app: TestApp['app'], path: string, cookie: string, fields: Record<string, string>): Promise<Response> {
  const body = new URLSearchParams(fields)
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, cookie },
    body: body.toString(),
  })
}

describe('user account portal', () => {
  let testApp: TestApp
  let user: RegisteredUser

  beforeEach(async () => {
    testApp = await createTestApp()
    await truncateAll(testApp.database)
    await flushRateLimits(testApp.redis)
    user = await registerUser(testApp.app, testApp.database, uniqueEmail(), PASSWORD)
  })

  afterAll(async () => {
    await testApp.close()
  })

  it('answers 401 with a login page when anonymous', async () => {
    for (const path of ['/account', '/account/sessions', '/account/tokens', '/account/password']) {
      const response = await jsonRequest(testApp.app, 'GET', path)
      expect(response.status).toBe(401)
      expect(await response.text()).toContain('需要登录')
    }
    // Mutations stay gated too, origin notwithstanding.
    const mutation = await testApp.app.request('/account/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
      body: 'name=x',
    })
    expect(mutation.status).toBe(401)
  })

  it('aggregates the last-7-days usage from llm_request_log and the media ledger', async () => {
    const seed = async (row: {
      modelId: string
      status: string
      totalTokens?: number
      inputTokens?: number
      outputTokens?: number
      createdAt: Date
    }) => {
      await testApp.database.db.insert(llmRequestLog).values({
        id: randomUUID(),
        requestId: randomUUID(),
        userId: user.userId,
        sessionId: 'seed',
        modelId: row.modelId,
        status: row.status,
        inputTokens: row.inputTokens ?? null,
        outputTokens: row.outputTokens ?? null,
        totalTokens: row.totalTokens ?? null,
        durationMs: 12,
        createdAt: row.createdAt,
      })
    }
    const now = Date.now()
    await seed({ modelId: 'm-one', status: 'complete', inputTokens: 10, outputTokens: 20, totalTokens: 30, createdAt: new Date(now) })
    await seed({ modelId: 'm-one', status: 'complete', inputTokens: 1, outputTokens: 2, totalTokens: 3, createdAt: new Date(now - 1000) })
    await seed({ modelId: 'm-two', status: 'failed', createdAt: new Date(now - 2000) })
    await seed({ modelId: 'm-two', status: 'rejected', createdAt: new Date(now - 3000) })
    // Outside the window: invisible.
    await seed({ modelId: 'm-old', status: 'complete', totalTokens: 9999, createdAt: new Date(now - 8 * 24 * 3600 * 1000) })
    const day = new Date().toISOString().slice(0, 10)
    await testApp.redis.commands.hIncrBy(`media:usage:${user.userId}:${day}`, 'requests', 5)
    await testApp.redis.commands.hIncrBy(`media:usage:${user.userId}:${day}`, 'model:img-x', 3)
    await testApp.redis.commands.hIncrBy(`media:usage:${user.userId}:${day}`, 'model:img-y', 2)

    const page = await jsonRequest(testApp.app, 'GET', '/account', undefined, { cookie: user.cookie })
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('近 7 天模型用量')
    expect(html).toContain('<div class="num">4</div>') // 请求总数
    expect(html).toContain('<div class="num">1</div>') // 失败
    expect(html).toContain('<div class="num">33</div>') // tokens 合计
    expect(html).toContain('<div class="num">11 / 22</div>') // 入 / 出
    expect(html).toContain('<div class="num">5</div>') // 媒体生成次数
    expect(html).toContain('<td>m-one</td>')
    expect(html).toContain('<td>2</td>')
    expect(html).not.toContain('m-old')
    expect(html).toContain('<td>img-x</td>')
  })

  it('lists sessions and revokes the other device instantly', async () => {
    const second = await signIn(testApp.app, user.email, PASSWORD)
    const secondCookie = cookieFrom(second)
    expect(second.status).toBe(200)

    const page = await jsonRequest(testApp.app, 'GET', '/account/sessions', undefined, { cookie: user.cookie })
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('当前会话')
    expect((html.match(/<tr>/g) ?? []).length).toBe(3) // header + two live sessions

    const currentSession = (await (
      await jsonRequest(testApp.app, 'GET', '/api/auth/get-session', undefined, { cookie: user.cookie })
    ).json()) as { session: { id: string } }
    const currentId = currentSession.session.id

    // The current session cannot be revoked from here.
    const selfRevoke = await formPost(testApp.app, `/account/sessions/${currentId}/revoke`, user.cookie, {})
    expect(selfRevoke.status).toBe(303)
    expect(selfRevoke.headers.get('location')).toContain('err=')

    // Revoke the OTHER live session: it dies server-side at once.
    const rows = await testApp.database.pool.query<{ id: string }>(
      'SELECT id FROM session WHERE user_id = $1 ORDER BY created_at DESC',
      [user.userId],
    )
    const otherId = rows.rows.find((row) => row.id !== currentId)!.id
    const revoke = await formPost(testApp.app, `/account/sessions/${otherId}/revoke`, user.cookie, {})
    expect(revoke.status).toBe(303)
    expect(revoke.headers.get('location')).toContain('ok=')
    expect((await jsonRequest(testApp.app, 'GET', '/v1/users/me', undefined, { cookie: secondCookie })).status).toBe(401)
    expect((await jsonRequest(testApp.app, 'GET', '/v1/users/me', undefined, { cookie: user.cookie })).status).toBe(200)
  })

  it('creates a token whose plaintext shows exactly once, then revokes it', async () => {
    const list = await jsonRequest(testApp.app, 'GET', '/account/tokens', undefined, { cookie: user.cookie })
    expect(list.status).toBe(200)
    expect(await list.text()).toContain('还没有 API 令牌')

    const created = await formPost(testApp.app, '/account/tokens', user.cookie, { name: 'portal-token' })
    expect(created.status).toBe(200)
    const html = await created.text()
    expect(html).toContain('portal-token')
    expect(html).toContain('bat_')
    const plaintext = /bat_[A-Za-z0-9_-]+/.exec(html)![0]

    // The list never shows it again; the database stores only the hash.
    const after = await jsonRequest(testApp.app, 'GET', '/account/tokens', undefined, { cookie: user.cookie })
    expect(await after.text()).not.toContain(plaintext)
    const stored = await testApp.database.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM api_tokens WHERE hash LIKE '%' || $1 || '%' OR name LIKE '%' || $1 || '%'",
      [plaintext],
    )
    expect(stored.rows[0]!.count).toBe('0')

    const rows = await testApp.database.pool.query<{ id: string }>('SELECT id FROM api_tokens')
    const revoke = await formPost(testApp.app, `/account/tokens/${rows.rows[0]!.id}/revoke`, user.cookie, {})
    expect(revoke.status).toBe(303)
    const revoked = await jsonRequest(testApp.app, 'GET', '/account/tokens', undefined, { cookie: user.cookie })
    expect(await revoked.text()).toContain('已撤销')
  })

  it('changes the password through Better Auth and gates on the current one', async () => {
    const wrong = await formPost(testApp.app, '/account/password', user.cookie, {
      current_password: 'totally-wrong', new_password: 'brand-new-pass-1', confirm_password: 'brand-new-pass-1',
    })
    expect(wrong.status).toBe(303)
    expect(wrong.headers.get('location')).toContain('err=')

    const mismatch = await formPost(testApp.app, '/account/password', user.cookie, {
      current_password: PASSWORD, new_password: 'brand-new-pass-1', confirm_password: 'different-pass-2',
    })
    expect(mismatch.status).toBe(303)
    expect(mismatch.headers.get('location')).toContain('err=')

    const ok = await formPost(testApp.app, '/account/password', user.cookie, {
      current_password: PASSWORD, new_password: 'brand-new-pass-1', confirm_password: 'brand-new-pass-1',
      revoke_other_sessions: 'on',
    })
    expect(ok.status).toBe(303)
    expect(ok.headers.get('location')).toContain('ok=')

    expect((await signIn(testApp.app, user.email, 'brand-new-pass-1')).status).toBe(200)
    expect((await signIn(testApp.app, user.email, PASSWORD)).status).toBe(401)
  })

  it('approves a device from the portal page and the terminal exchanges it', async () => {
    const requested = await jsonRequest(testApp.app, 'POST', '/api/auth/device/code', {}, {
      'user-agent': 'hermes-headless/1.0 (linux)',
    })
    const { code } = ((await requested.json()) as { data: { code: string } }).data

    const page = await jsonRequest(testApp.app, 'GET', `/account/device?code=${code}`, undefined, { cookie: user.cookie })
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('hermes-headless/1.0 (linux)')
    expect(html).toContain('待批准')

    const approve = await formPost(testApp.app, '/account/device/approve', user.cookie, { code })
    expect(approve.status).toBe(303)
    expect(approve.headers.get('location')).toContain('ok=')

    const exchange = await jsonRequest(testApp.app, 'POST', '/api/auth/device/token', { code })
    expect(exchange.status).toBe(200)
    expect(((await exchange.json()) as { data: { token: string } }).data.token.startsWith('bat_')).toBe(true)
  })

  it('blocks portal mutations without a matching Origin', async () => {
    const noOrigin = await testApp.app.request('/account/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: user.cookie },
      body: 'name=x',
    })
    expect(noOrigin.status).toBe(403)
  })
})
