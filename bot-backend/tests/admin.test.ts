import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { llmRequestLog, userQuotas } from '../src/db/schema.js'
import { eq } from 'drizzle-orm'
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
 * 运营管理后台: the console gate is the session's admin role (seeded from
 * BOT_BACKEND_ADMIN_EMAILS at sign-up), 停用 goes through the library —
 * sessions die instantly and re-login is refused — catalog/quota writes
 * govern the model gateway before any vendor call, and every attributed
 * gateway request lands in llm_request_log for the 请求 page.
 */

const BASE = 'http://127.0.0.1:3100'
const ADMIN_EMAIL = 'ops-admin@test.local'
const ADMIN_PASSWORD = 'password-123456'

const TEXT_MODEL = { id: 'company-default', provider: 'openai' as const, model: 'gpt-test', enabled: true }

const STOP_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
}

function stopModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'finish', finishReason: { unified: 'stop' }, usage: STOP_USAGE },
      ] as LanguageModelV4StreamPart[]),
    }),
  })
}

function streamBody(model = 'company-default') {
  return { model, messages: [{ role: 'user', content: '你好' }] }
}

async function formPost(app: TestApp['app'], path: string, cookie: string, fields: Record<string, string>): Promise<Response> {
  const body = new URLSearchParams(fields)
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, cookie },
    body: body.toString(),
  })
}

async function postJson(app: TestApp['app'], cookie: string, body: unknown): Promise<Response> {
  return app.request('/api/llm/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, cookie },
    body: JSON.stringify(body),
  })
}

describe('operations console', () => {
  let testApp: TestApp
  let admin: RegisteredUser
  let plain: RegisteredUser

  beforeEach(async () => {
    testApp = await createTestApp({
      OPENAI_API_KEY: 'test-key',
      ANTHROPIC_API_KEY: 'test-anthropic-key',
      BOT_BACKEND_ADMIN_EMAILS: ADMIN_EMAIL,
      LLM_MODEL_CATALOG: JSON.stringify([TEXT_MODEL]),
    })
    await truncateAll(testApp.database)
    await flushRateLimits(testApp.redis)
    // The listed email signs up straight into role=admin.
    const seeded = await jsonRequest(testApp.app, 'POST', '/api/auth/sign-up/email', {
      name: 'ops', email: ADMIN_EMAIL, password: ADMIN_PASSWORD,
    })
    if (seeded.status !== 200) {
      throw new Error(`admin signup ${seeded.status}: ${await seeded.text()}`)
    }
    admin = { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, cookie: cookieFrom(seeded), userId: '' }
    const session = await jsonRequest(testApp.app, 'GET', '/api/auth/get-session', undefined, { cookie: admin.cookie })
    admin.userId = ((await session.json()) as { user: { id: string } }).user.id
    plain = await registerUser(testApp.app, testApp.database, uniqueEmail(), 'password-123456')
  })

  afterAll(async () => {
    await testApp.close()
  })

  it('seeds role=admin for BOT_BACKEND_ADMIN_EMAILS registrations only', async () => {
    const session = await jsonRequest(testApp.app, 'GET', '/api/auth/get-session', undefined, { cookie: admin.cookie })
    expect(((await session.json()) as { user: { role: string } }).user.role).toBe('admin')
    const plainSession = await jsonRequest(testApp.app, 'GET', '/api/auth/get-session', undefined, { cookie: plain.cookie })
    expect(((await plainSession.json()) as { user: { role: string } }).user.role).toBe('user')
  })

  it('gates the console on the admin role', async () => {
    expect((await jsonRequest(testApp.app, 'GET', '/admin', undefined, { cookie: plain.cookie })).status).toBe(403)
    expect((await jsonRequest(testApp.app, 'GET', '/admin')).status).toBe(403)
    const allowed = await jsonRequest(testApp.app, 'GET', '/admin', undefined, { cookie: admin.cookie })
    expect(allowed.status).toBe(200)
    expect(await allowed.text()).toContain('运营管理后台')
  })

  it('blocks console mutations without a matching Origin', async () => {
    const noOrigin = await testApp.app.request(`/admin/users/${plain.userId}/ban`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: admin.cookie },
      body: 'reason=test',
    })
    expect(noOrigin.status).toBe(403)
  })

  it('bans a user: sessions die instantly and re-login is refused until unbanned', async () => {
    expect((await jsonRequest(testApp.app, 'GET', '/v1/users/me', undefined, { cookie: plain.cookie })).status).toBe(200)

    expect((await formPost(testApp.app, `/admin/users/${plain.userId}/ban`, admin.cookie, { reason: '滥用' })).status).toBe(303)
    expect((await jsonRequest(testApp.app, 'GET', '/v1/users/me', undefined, { cookie: plain.cookie })).status).toBe(401)
    expect((await signIn(testApp.app, plain.email, plain.password)).status).toBe(403)

    expect((await formPost(testApp.app, `/admin/users/${plain.userId}/unban`, admin.cookie, {})).status).toBe(303)
    expect((await signIn(testApp.app, plain.email, plain.password)).status).toBe(200)
  })

  it('refuses to ban or demote yourself', async () => {
    const selfBan = await formPost(testApp.app, `/admin/users/${admin.userId}/ban`, admin.cookie, { reason: 'x' })
    expect(selfBan.headers.get('location') ?? '').toContain('err=')
    const selfDemote = await formPost(testApp.app, `/admin/users/${admin.userId}/role`, admin.cookie, { role: 'user' })
    expect(selfDemote.headers.get('location') ?? '').toContain('err=')
    // Both no-ops actually happened: still admin, not banned.
    const session = await jsonRequest(testApp.app, 'GET', '/api/auth/get-session', undefined, { cookie: admin.cookie })
    expect(((await session.json()) as { user: { role: string } }).user.role).toBe('admin')
  })

  it('persists quota overrides and the gateway enforces them before any vendor call', async () => {
    expect(
      (await formPost(testApp.app, `/admin/users/${plain.userId}/quota`, admin.cookie, {
        daily_token_limit: '1000',
        concurrency_limit: '1',
        model_allowlist: 'company-default, other-model',
      })).status,
    ).toBe(303)
    const rows = await testApp.database.db.select().from(userQuotas).where(eq(userQuotas.userId, plain.userId)).limit(1)
    expect(rows[0]?.dailyTokenLimit).toBe(1000)
    expect(rows[0]?.concurrencyLimit).toBe(1)
    expect(JSON.parse(rows[0]?.modelAllowlist ?? '[]')).toEqual(['company-default', 'other-model'])

    // The daily budget reads usage already recorded for today.
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '')
    await testApp.redis.commands.hIncrBy(`llm:usage:${plain.userId}:${day}`, 'total_tokens', 1000)
    const exhausted = await postJson(testApp.app, plain.cookie, streamBody())
    expect(exhausted.status).toBe(429)
    expect(((await exhausted.json()) as { error: { code: string } }).error.code).toBe('quota_exceeded')
  })

  it('CRUDs the model catalog through the console and the gateway follows', async () => {
    expect(
      (await formPost(testApp.app, '/admin/models', admin.cookie, {
        id: 'console-model', provider: 'anthropic', model: 'claude-test', display_name: '控制台模型',
        max_output_tokens: '512', context_length: '100000', note: 'ops added', enabled: 'on', is_default: 'on',
      })).status,
    ).toBe(303)

    const models = await jsonRequest(testApp.app, 'GET', '/api/llm/models', undefined, { cookie: admin.cookie })
    const body = (await models.json()) as { models: Array<{ id: string; maxOutputTokens?: number }>; defaultModel: string | null }
    expect(body.models.map((model) => model.id)).toContain('console-model')
    expect(body.defaultModel).toBe('console-model')

    expect((await formPost(testApp.app, '/admin/models/console-model/toggle', admin.cookie, {})).status).toBe(303)
    const afterToggle = await jsonRequest(testApp.app, 'GET', '/api/llm/models', undefined, { cookie: admin.cookie })
    expect(((await afterToggle.json()) as { models: Array<{ id: string }> }).models.map((model) => model.id)).not.toContain(
      'console-model',
    )

    expect((await formPost(testApp.app, '/admin/models/console-model/delete', admin.cookie, {})).status).toBe(303)
    const afterDelete = await jsonRequest(testApp.app, 'GET', '/api/llm/models', undefined, { cookie: admin.cookie })
    // The env-catalog seed (company-default) survives; only the console row is gone.
    expect(((await afterDelete.json()) as { models: Array<{ id: string }> }).models.map((model) => model.id)).toEqual([
      'company-default',
    ])
  })

  it('journal-logs rejected and completed gateway requests for the 请求 page', async () => {
    const seam = await createTestApp(
      {
        OPENAI_API_KEY: 'test-key',
        BOT_BACKEND_ADMIN_EMAILS: ADMIN_EMAIL,
        LLM_MODEL_CATALOG: JSON.stringify([TEXT_MODEL]),
      },
      { modelResolver: () => stopModel() },
    )
    try {
      // Rejected: unknown model — attributed, before any vendor call.
      const rejected = await postJson(testApp.app, admin.cookie, streamBody('nope'))
      expect(rejected.status).toBe(404)
      // Complete: a real stream through the seam app (same test Postgres).
      const seamUser = await registerUser(seam.app, seam.database, uniqueEmail(), 'password-123456')
      const ok = await postJson(seam.app, seamUser.cookie, streamBody())
      expect(ok.status).toBe(200)
      await ok.text()

      const rows = await testApp.database.db.select().from(llmRequestLog)
      const byStatus = (status: string) => rows.filter((row) => row.status === status)
      expect(byStatus('rejected').map((row) => row.modelId)).toEqual(['nope'])
      expect(byStatus('complete').map((row) => row.totalTokens)).toEqual([5])
    } finally {
      await seam.close()
    }
  })

  it('shows the status page to admins', async () => {
    const status = await jsonRequest(testApp.app, 'GET', '/admin/status', undefined, { cookie: admin.cookie })
    expect(status.status).toBe(200)
    const html = await status.text()
    expect(html).toContain('PostgreSQL')
    expect(html).toContain('Redis')
  })
})
