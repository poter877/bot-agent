import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createTestApp,
  flushRateLimits,
  jsonRequest,
  login,
  registerAndVerify,
  truncateAll,
  uniqueEmail,
  type TestApp,
} from './helpers.js'

const PASSWORD = 'correct-horse-battery'

describe('login and authenticated profile', () => {
  let testApp: TestApp

  beforeAll(async () => {
    testApp = await createTestApp()
  })

  beforeEach(async () => {
    await truncateAll(testApp.database)
    await flushRateLimits(testApp.redis)
  })

  afterAll(async () => {
    await testApp.close()
  })

  it('issues device-scoped credentials and serves the minimal profile', async () => {
    const email = uniqueEmail()
    await registerAndVerify(testApp.app, testApp.database, email, PASSWORD)

    const result = await login(testApp.app, email, PASSWORD)
    expect(result.accessToken).toMatch(/^eyJ/)
    expect(result.refreshToken.length).toBeGreaterThanOrEqual(20)
    expect(result.expiresInSeconds).toBe(testApp.config.ACCESS_TOKEN_TTL_SECONDS)
    expect(result.user.email).toBe(email)
    expect(result.user.status).toBe('active')

    const me = await jsonRequest(testApp.app, 'GET', '/v1/users/me', undefined, {
      authorization: `Bearer ${result.accessToken}`,
    })
    expect(me.status).toBe(200)
    const meBody = (await me.json()) as { data: { user: Record<string, unknown> } }
    expect(meBody.data.user.email).toBe(email)
    // Minimal profile: internal columns never leave the service.
    expect(JSON.stringify(meBody)).not.toContain('password_hash')
    expect(JSON.stringify(meBody)).not.toContain('refresh_token')

    const session = await testApp.database.pool.query(
      'SELECT device_id FROM login_sessions WHERE user_id = $1',
      [result.user.id],
    )
    expect(session.rows).toHaveLength(1)
  })

  it('rejects wrong and unknown credentials with one indistinguishable error', async () => {
    const email = uniqueEmail()
    await registerAndVerify(testApp.app, testApp.database, email, PASSWORD)

    const wrong = await jsonRequest(testApp.app, 'POST', '/v1/auth/login', {
      email,
      password: 'totally-wrong-pass',
    })
    const unknown = await jsonRequest(testApp.app, 'POST', '/v1/auth/login', {
      email: uniqueEmail(),
      password: 'totally-wrong-pass',
    })
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    const wrongBody = (await wrong.json()) as { error: unknown }
    const unknownBody = (await unknown.json()) as { error: unknown }
    // Identical error contract (request ids differ by design).
    expect(unknownBody.error).toEqual(wrongBody.error)
  })

  it('tells the legitimate holder about an unverified account only after the password matches', async () => {
    const email = uniqueEmail()
    await jsonRequest(testApp.app, 'POST', '/v1/auth/register', { email, password: PASSWORD })

    const wrongPassword = await jsonRequest(testApp.app, 'POST', '/v1/auth/login', {
      email,
      password: 'not-the-password',
    })
    expect(wrongPassword.status).toBe(401)

    const correctPassword = await jsonRequest(testApp.app, 'POST', '/v1/auth/login', { email, password: PASSWORD })
    expect(correctPassword.status).toBe(403)
    const body = (await correctPassword.json()) as { error: { code: string } }
    expect(body.error.code).toBe('account_not_verified')
  })

  it('rate limits repeated login attempts per normalized account', async () => {
    const limited = await createTestApp({
      RATE_LIMIT_LOGIN_ACCOUNT_MAX: '2',
      RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_SECONDS: '60',
    })
    try {
      const email = uniqueEmail()
      await registerAndVerify(limited.app, limited.database, email, PASSWORD)
      await flushRateLimits(limited.redis)

      const first = await jsonRequest(limited.app, 'POST', '/v1/auth/login', { email, password: 'bad-pass-1' })
      const second = await jsonRequest(limited.app, 'POST', '/v1/auth/login', { email, password: 'bad-pass-2' })
      const third = await jsonRequest(limited.app, 'POST', '/v1/auth/login', { email, password: 'bad-pass-3' })
      expect(first.status).toBe(401)
      expect(second.status).toBe(401)
      expect(third.status).toBe(429)
      expect(third.headers.get('retry-after')).toMatch(/^\d+$/)
      const thirdBody = (await third.json()) as { error: { code: string }; request_id: string }
      expect(thirdBody.error.code).toBe('rate_limited')
      expect(thirdBody.request_id).toBeTruthy()
    } finally {
      await limited.close()
    }
  })
})
