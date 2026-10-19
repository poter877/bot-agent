import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { user } from '../src/db/schema.js'
import {
  createTestApp,
  registerUser,
  truncateAll,
  uniqueEmail,
  type TestApp,
} from './helpers.js'

/**
 * 首启初始化向导（/admin/setup）: the only anonymous write path, open exactly
 * while zero role=admin accounts exist. It must mint the first admin with a
 * live session, then close itself for good — GET and POST both refuse once an
 * admin exists, so a stale tab can never escalate a second account.
 */

const BASE = 'http://127.0.0.1:3100'
const PASSWORD = 'password-123456'

async function postSetup(app: TestApp['app'], fields: Record<string, string>): Promise<Response> {
  const body = new URLSearchParams(fields)
  return app.request('/admin/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
    body: body.toString(),
    redirect: 'manual',
  })
}

describe('admin bootstrap setup', () => {
  it('offers the wizard before initialization and funnels anonymous console visits to it', async () => {
    const t = await createTestApp({ BOT_BACKEND_ADMIN_EMAILS: '' })
    await truncateAll(t.database)
    const page = await t.app.request('/admin/setup')
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('创建第一个管理员')

    const gate = await t.app.request('/admin', { redirect: 'manual' })
    expect(gate.status).toBe(303)
    expect(gate.headers.get('location')).toContain('/admin/setup')
    await t.close()
  })

  it('creates the first admin, persists role=admin and lands signed in on the console', async () => {
    const t = await createTestApp({ BOT_BACKEND_ADMIN_EMAILS: '' })
    await truncateAll(t.database)
    const email = uniqueEmail()
    const res = await postSetup(t.app, {
      email,
      name: '运维',
      password: PASSWORD,
      confirm: PASSWORD,
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('/admin')

    const [row] = await t.database.db.select().from(user).where(eq(user.email, email))
    expect(row?.role).toBe('admin')

    // The minted session cookie opens the console directly.
    const cookies = res.headers.getSetCookie()
    expect(cookies.length).toBeGreaterThan(0)
    const console_ = await t.app.request('/admin', { headers: { cookie: cookies.map((c) => c.split(';')[0]).join('; ') } })
    expect(console_.status).toBe(200)
    expect(await console_.text()).toContain('运营管理后台')
    await t.close()
  })

  it('closes for good once an admin exists: GET is 403 and POST never escalates a second account', async () => {
    const t = await createTestApp({ BOT_BACKEND_ADMIN_EMAILS: 'seed-admin@test.local' })
    await truncateAll(t.database)
    await registerUser(t.app, t.database, 'seed-admin@test.local', PASSWORD)

    const page = await t.app.request('/admin/setup')
    expect(page.status).toBe(403)

    const email = uniqueEmail()
    const res = await postSetup(t.app, { email, password: PASSWORD, confirm: PASSWORD })
    expect(res.status).toBe(403)
    const [row] = await t.database.db.select().from(user).where(eq(user.email, email))
    expect(row).toBeUndefined()
    await t.close()
  })

  it('rejects mismatched passwords with a flash and creates no account', async () => {
    const t = await createTestApp({ BOT_BACKEND_ADMIN_EMAILS: '' })
    await truncateAll(t.database)
    const res = await postSetup(t.app, {
      email: uniqueEmail(),
      password: PASSWORD,
      confirm: `${PASSWORD}-nope`,
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('err=')
    const rows = await t.database.db.select().from(user)
    expect(rows).toHaveLength(0)
    await t.close()
  })
})
