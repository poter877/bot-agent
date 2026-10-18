import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { deviceCodes } from '../src/db/schema.js'
import {
  createTestApp,
  flushRateLimits,
  jsonRequest,
  registerUser,
  truncateAll,
  uniqueEmail,
  type RegisteredUser,
  type TestApp,
} from './helpers.js'

/**
 * 设备码登录全链路（无头终端 → 浏览器批准 → 换 bat_ 令牌）：
 * code → approve → token；未批准 authorization_pending；过期 / 重复消费 /
 * 批准后再批均拒绝；approve 仅限会话登录者；创建端点受 entry-ip 限流。
 */

const PASSWORD = 'correct-horse-battery'
const HEADLESS_UA = 'hermes-headless/1.0 (linux)'
const CODE_SHAPE = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/

interface DeviceCode {
  code: string
  verify_url: string
  expires_in: number
}

async function requestCode(app: TestApp['app']): Promise<DeviceCode> {
  const response = await jsonRequest(app, 'POST', '/api/auth/device/code', {}, { 'user-agent': HEADLESS_UA })
  expect(response.status).toBe(200)
  return ((await response.json()) as { data: DeviceCode }).data
}

async function pollToken(app: TestApp['app'], code: string): Promise<Response> {
  return jsonRequest(app, 'POST', '/api/auth/device/token', { code })
}

async function approve(app: TestApp['app'], cookie: string, code: string): Promise<Response> {
  return jsonRequest(app, 'POST', '/api/auth/device/approve', { code }, { cookie })
}

describe('device login flow', () => {
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

  it('runs the full code → approve → token chain', async () => {
    const { code, verify_url, expires_in } = await requestCode(testApp.app)
    expect(code).toMatch(CODE_SHAPE)
    expect(verify_url).toContain(`/account/device?code=${code}`)
    expect(expires_in).toBe(600)

    // Only the hash lands in the database, with the applicant's UA.
    const rows = await testApp.database.db.select().from(deviceCodes)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.codeHash).not.toContain(code.replaceAll('-', ''))
    expect(rows[0]!.userAgent).toBe(HEADLESS_UA)
    expect(rows[0]!.userId).toBeNull()

    expect(await approve(testApp.app, user.cookie, code)).toHaveProperty('status', 200)
    const bound = await testApp.database.db.select().from(deviceCodes)
    expect(bound[0]!.userId).toBe(user.userId)
    expect(bound[0]!.approvedAt).not.toBeNull()

    const exchange = await pollToken(testApp.app, code)
    expect(exchange.status).toBe(200)
    const issued = (await exchange.json()) as { data: { token: string; name: string } }
    expect(issued.data.token.startsWith('bat_')).toBe(true)
    expect(issued.data.name).toBe(`device-${new Date().toISOString().slice(0, 10)}`)

    // The issued token is a real bearer credential.
    const models = await jsonRequest(testApp.app, 'GET', '/api/llm/models', undefined, {
      authorization: `Bearer ${issued.data.token}`,
    })
    expect(models.status).toBe(200)
  })

  it('answers authorization_pending until approved', async () => {
    const { code } = await requestCode(testApp.app)
    const pending = await pollToken(testApp.app, code)
    expect(pending.status).toBe(400)
    expect(((await pending.json()) as { error: { code: string } }).error.code).toBe('authorization_pending')
  })

  it('rejects double consumption and post-consumption approval', async () => {
    const { code } = await requestCode(testApp.app)
    await approve(testApp.app, user.cookie, code)
    expect((await pollToken(testApp.app, code)).status).toBe(200)

    const replay = await pollToken(testApp.app, code)
    expect(replay.status).toBe(409)
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe('conflict')

    const reapprove = await approve(testApp.app, user.cookie, code)
    expect(reapprove.status).toBe(409)
  })

  it('refuses expired codes on both endpoints', async () => {
    const { code } = await requestCode(testApp.app)
    // Age the row past its TTL (expiry is enforced by query predicates).
    await testApp.database.db.update(deviceCodes).set({ expiresAt: new Date(Date.now() - 1000) })

    const exchange = await pollToken(testApp.app, code)
    expect(exchange.status).toBe(400)
    expect(((await exchange.json()) as { error: { code: string } }).error.code).toBe('device_code_expired')

    const approval = await approve(testApp.app, user.cookie, code)
    expect(approval.status).toBe(400)
  })

  it('approve requires a session and rejects codes claimed by another account', async () => {
    const { code } = await requestCode(testApp.app)
    expect((await approve(testApp.app, '', code)).status).toBe(401)

    const stranger = await registerUser(testApp.app, testApp.database, uniqueEmail(), PASSWORD)
    expect((await approve(testApp.app, stranger.cookie, code)).status).toBe(200)
    const ownerApproval = await approve(testApp.app, user.cookie, code)
    expect(ownerApproval.status).toBe(409)
  })

  it('answers 404 for unknown codes without confirming existence', async () => {
    expect((await pollToken(testApp.app, 'ZZZZ-ZZZZ')).status).toBe(404)
    const missing = await approve(testApp.app, user.cookie, 'ZZZZ-ZZZZ')
    expect(missing.status).toBe(404)
  })

  it('rate-limits anonymous code creation per entry ip', async () => {
    const limited = await createTestApp({ RATE_LIMIT_ENTRY_MAX: '2', RATE_LIMIT_ENTRY_WINDOW_SECONDS: '60' })
    try {
      await flushRateLimits(limited.redis)
      expect((await requestCode(limited.app)).code).toMatch(CODE_SHAPE)
      expect((await requestCode(limited.app)).code).toMatch(CODE_SHAPE)
      const third = await jsonRequest(limited.app, 'POST', '/api/auth/device/code', {})
      expect(third.status).toBe(429)
      expect(((await third.json()) as { error: { code: string } }).error.code).toBe('rate_limited')
    } finally {
      await limited.close()
    }
  })
})
