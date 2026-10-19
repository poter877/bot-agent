import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { user } from '../src/db/schema.js'
import {
  cookieFrom,
  createTestApp,
  jsonRequest,
  registerUser,
  truncateAll,
  uniqueEmail,
} from './helpers.js'

/**
 * 运营后台 JSON API（/admin/api/*，/console SPA 的数据面）:
 * bootstrap/setup 是唯一的免登录读写对，其余端点一律实时复核 role=admin；
 * setup 关闭后拒绝升级第二个账号；模型目录 CRUD 与 HTML 控制台同一 catalogStore。
 */

const BASE = 'http://127.0.0.1:3100'
const PASSWORD = 'password-123456'

async function postApi(app: Awaited<ReturnType<typeof createTestApp>>['app'], path: string, body: unknown, cookie?: string): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: BASE,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
    redirect: 'manual',
  })
}

describe('admin json api', () => {
  it('exposes bootstrap state anonymously and gates everything else behind role=admin', async () => {
    const t = await createTestApp({ BOT_BACKEND_ADMIN_EMAILS: '' })
    await truncateAll(t.database)

    const boot = await t.app.request('/admin/api/bootstrap')
    expect(boot.status).toBe(200)
    expect(await boot.json()).toMatchObject({ code: 200, data: { initialized: false } })

    const denied = await t.app.request('/admin/api/users')
    expect(denied.status).toBe(403)
    await t.close()
  })

  it('setup creates the first admin with a session cookie; repeat setup is refused', async () => {
    const t = await createTestApp({ BOT_BACKEND_ADMIN_EMAILS: '' })
    await truncateAll(t.database)

    const email = uniqueEmail()
    const res = await postApi(t.app, '/admin/api/setup', { email, password: PASSWORD, confirm: PASSWORD })
    expect(res.status).toBe(200)
    const cookie = cookieFrom(res)
    expect(cookie).toContain('better-auth')

    const [row] = await t.database.db.select().from(user).where(eq(user.email, email))
    expect(row?.role).toBe('admin')

    const boot = await t.app.request('/admin/api/bootstrap')
    expect(((await boot.json()) as { data: { initialized: boolean } }).data.initialized).toBe(true)

    const again = await postApi(t.app, '/admin/api/setup', { email: uniqueEmail(), password: PASSWORD, confirm: PASSWORD })
    expect(again.status).toBe(403)

    // The minted cookie authorizes admin endpoints…
    const users = await t.app.request('/admin/api/users', { headers: { cookie } })
    expect(users.status).toBe(200)
    // …and wrong-origin writes stay blocked (CSRF).
    const csrf = await t.app.request('/admin/api/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example', cookie },
      body: JSON.stringify({ id: 'x', provider: 'openai', model: 'gpt-x' }),
    })
    expect(csrf.status).toBe(403)
    await t.close()
  })

  it('manages the model catalog through catalogStore semantics', async () => {
    const t = await createTestApp({ BOT_BACKEND_ADMIN_EMAILS: 'seed@test.local' })
    await truncateAll(t.database)
    const admin = await registerUser(t.app, t.database, 'seed@test.local', PASSWORD)

    const upsert = await jsonRequest(t.app, 'POST', '/admin/api/models', {
      id: 'glm-4.7', provider: 'openai', model: 'glm-4.7-flash', displayName: 'GLM-4.7', default: true,
    }, { cookie: admin.cookie, origin: BASE })
    expect(upsert.status).toBe(200)

    const listed = await t.app.request('/admin/api/models', { headers: { cookie: admin.cookie } })
    const rows = ((await listed.json()) as { data: Array<{ id: string; isDefault: boolean; enabled: boolean }> }).data
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'glm-4.7', isDefault: true, enabled: true })

    const toggled = await jsonRequest(t.app, 'POST', '/admin/api/models/glm-4.7/toggle', undefined, { cookie: admin.cookie, origin: BASE })
    expect(toggled.status).toBe(200)
    const afterJson = (await (await t.app.request('/admin/api/models', { headers: { cookie: admin.cookie } })).json()) as { data: Array<{ enabled: boolean }> }
    expect(afterJson.data[0]?.enabled).toBe(false)

    const removed = await t.app.request('/admin/api/models/glm-4.7', {
      method: 'DELETE', headers: { origin: BASE, cookie: admin.cookie },
    })
    expect(removed.status).toBe(200)
    const emptiedJson = (await (await t.app.request('/admin/api/models', { headers: { cookie: admin.cookie } })).json()) as { data: unknown[] }
    expect(emptiedJson.data).toHaveLength(0)
    await t.close()
  })

  it('stores model credentials write-only and never echoes the key back', async () => {
    const t = await createTestApp({ BOT_BACKEND_ADMIN_EMAILS: 'seed@test.local' })
    await truncateAll(t.database)
    const admin = await registerUser(t.app, t.database, 'seed@test.local', PASSWORD)

    const upsert = await jsonRequest(t.app, 'POST', '/admin/api/models', {
      id: 'glm-4.7', provider: 'openai', model: 'glm-4.7-flash',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4/', apiKey: 'sk-zhipu-secret-9876',
    }, { cookie: admin.cookie, origin: BASE })
    expect(upsert.status).toBe(200)

    // The model listing carries the endpoint but never the key.
    const listed = ((await (await t.app.request('/admin/api/models', { headers: { cookie: admin.cookie } })).json()) as { data: Array<{ id: string; baseUrl: string | null }> }).data
    expect(listed[0]).toMatchObject({ id: 'glm-4.7', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' })

    // The credentials endpoint returns masked hints only.
    const creds = ((await (await t.app.request('/admin/api/credentials', { headers: { cookie: admin.cookie } })).json()) as { data: Array<{ provider: string; baseUrl: string; hint: string }> }).data
    expect(creds).toHaveLength(1)
    expect(creds[0]!).toMatchObject({ provider: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' })
    expect(creds[0]!.hint).toContain('9876')
    expect(creds[0]!.hint).not.toContain('sk-zhipu-secret-9876')

    // Raw row keeps the full key server-side (credential lookup input).
    const stored = await t.database.pool.query("SELECT api_key FROM llm_provider_credentials WHERE provider = 'openai'")
    expect(stored.rows[0]?.api_key).toBe('sk-zhipu-secret-9876')
    await t.close()
  })

  it('flips roles through the better-auth admin api, never direct column writes', async () => {
    const t = await createTestApp({ BOT_BACKEND_ADMIN_EMAILS: 'seed@test.local' })
    await truncateAll(t.database)
    const admin = await registerUser(t.app, t.database, 'seed@test.local', PASSWORD)
    const member = await registerUser(t.app, t.database, uniqueEmail(), PASSWORD)

    const res = await postApi(t.app, `/admin/api/users/${member.userId}/role`, { role: 'admin' }, admin.cookie)
    expect(res.status).toBe(200)
    const [row] = await t.database.db.select().from(user).where(eq(user.id, member.userId))
    expect(row?.role).toBe('admin')
    await t.close()
  })
})
