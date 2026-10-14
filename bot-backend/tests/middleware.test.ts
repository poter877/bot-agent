import { Hono } from 'hono'
import { sign } from 'hono/jwt'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { processingTimeout } from '../src/middleware/timeout.js'
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

describe('production request boundary', () => {
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

  it('sets security headers and no-store on success and error responses alike', async () => {
    const ok = await jsonRequest(testApp.app, 'GET', '/healthz')
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff')
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect(ok.headers.get('x-frame-options')).toBe('DENY')
    expect(ok.headers.get('strict-transport-security')).toContain('max-age=31536000')
    expect(ok.headers.get('x-request-id')).toMatch(/[\w-]{10,}/)

    const miss = await jsonRequest(testApp.app, 'GET', '/v1/definitely-not-a-route')
    // Default-deny: an unknown /v1 path demands authentication before it even
    // admits the route does not exist.
    expect(miss.status).toBe(401)
    expect(miss.headers.get('cache-control')).toBe('no-store')

    const outside = await jsonRequest(testApp.app, 'GET', '/also-not-a-route')
    expect(outside.status).toBe(404)
    expect(outside.headers.get('cache-control')).toBe('no-store')
    const missBody = (await outside.json()) as { error: { code: string }; request_id: string }
    expect(missBody.error.code).toBe('not_found')
    expect(missBody.request_id).toBeTruthy()
  })

  it('mints its own request id and ignores a client-supplied one', async () => {
    const response = await jsonRequest(testApp.app, 'GET', '/healthz', undefined, {
      'x-request-id': 'attacker-chosen-id',
    })
    expect(response.headers.get('x-request-id')).not.toBe('attacker-chosen-id')
  })

  it('maps malformed JSON to 400 and non-JSON media types to 415', async () => {
    const malformed = await appRawRequest(testApp, 'POST', '/v1/auth/login', '{"email": "a@b.c",,', {
      'content-type': 'application/json',
    })
    expect(malformed.status).toBe(400)
    expect(((await malformed.json()) as { error: { code: string } }).error.code).toBe('invalid_json')

    const wrongType = await appRawRequest(testApp, 'POST', '/v1/auth/login', 'a=1', {
      'content-type': 'application/x-www-form-urlencoded',
    })
    expect(wrongType.status).toBe(415)
    expect(((await wrongType.json()) as { error: { code: string } }).error.code).toBe('unsupported_media_type')
  })

  it('enforces the 16 KiB body budget with 413', async () => {
    const oversized = await jsonRequest(testApp.app, 'POST', '/v1/auth/login', {
      email: uniqueEmail(),
      password: 'x'.repeat(17 * 1024),
    })
    expect(oversized.status).toBe(413)
    expect(((await oversized.json()) as { error: { code: string } }).error.code).toBe('payload_too_large')
  })

  it('rejects protected routes without, with forged, or with garbage credentials', async () => {
    const none = await jsonRequest(testApp.app, 'GET', '/v1/users/me')
    expect(none.status).toBe(401)

    const garbage = await jsonRequest(testApp.app, 'GET', '/v1/users/me', undefined, {
      authorization: 'Bearer not-a-jwt',
    })
    expect(garbage.status).toBe(401)

    // Valid shape, wrong signing key.
    const forged = await jsonRequest(testApp.app, 'GET', '/v1/users/me', undefined, {
      authorization: `Bearer ${await signForgedToken()}`,
    })
    expect(forged.status).toBe(401)
    expect(((await forged.json()) as { error: { code: string } }).error.code).toBe('unauthorized')
  })

  it('binds the token subject to the session owner (no cross-user tokens)', async () => {
    const emailA = uniqueEmail()
    const emailB = uniqueEmail()
    await registerAndVerify(testApp.app, testApp.database, emailA, PASSWORD)
    await registerAndVerify(testApp.app, testApp.database, emailB, PASSWORD)
    const userA = await login(testApp.app, emailA, PASSWORD)
    const userB = await login(testApp.app, emailB, PASSWORD)

    const sessionB = await testApp.database.pool.query(
      'SELECT id FROM login_sessions WHERE user_id = $1 LIMIT 1',
      [userB.user.id],
    )
    const sessionIdB = sessionB.rows[0]!.id as string

    // Correctly signed by this very service, but sub=A paired with sid=B.
    const now = Math.floor(Date.now() / 1000)
    const crossToken = await sign(
      {
        sub: userA.user.id,
        sid: sessionIdB,
        did: 'device-x',
        iss: testApp.config.JWT_ISSUER,
        aud: testApp.config.JWT_AUDIENCE,
        iat: now,
        exp: now + 600,
      },
      testApp.config.AUTH_JWT_SECRET,
      'HS256',
    )
    const cross = await jsonRequest(testApp.app, 'GET', '/v1/users/me', undefined, {
      authorization: `Bearer ${crossToken}`,
    })
    expect(cross.status).toBe(401)
    expect(userA.accessToken).not.toBe(userB.accessToken)
  })

  it('applies the shared entry budget across every /v1 request', async () => {
    const limited = await createTestApp({ RATE_LIMIT_ENTRY_MAX: '3' })
    try {
      await flushRateLimits(limited.redis)
      const statuses: number[] = []
      for (let i = 0; i < 5; i += 1) {
        const response = await jsonRequest(limited.app, 'GET', '/healthz') // outside /v1
        expect(response.status).toBe(200)
        const limitedResponse = await jsonRequest(limited.app, 'POST', '/v1/auth/login', {
          email: uniqueEmail(),
          password: 'whatever-pass',
        })
        statuses.push(limitedResponse.status)
      }
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401])
      expect(statuses.slice(3)).toEqual([429, 429])
      expect(statuses).not.toContain(503)
    } finally {
      await limited.close()
    }
  })

  it('fails closed with 503 when Redis cannot answer', async () => {
    const brokenRedis = await createTestApp({ REDIS_URL: 'redis://127.0.0.1:1' })
    try {
      const response = await jsonRequest(brokenRedis.app, 'POST', '/v1/auth/login', {
        email: uniqueEmail(),
        password: 'whatever-pass',
      })
      expect(response.status).toBe(503)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('dependency_unavailable')
    } finally {
      await brokenRedis.close()
    }
  })

  it('bounds handler processing with a 503 budget overrun', async () => {
    const mini = new Hono()
    mini.use('*', processingTimeout(200))
    mini.get('/slow', async (c) => {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      return c.json({ ok: true })
    })
    const response = await mini.request('/slow')
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('request_timeout')
  })
})

async function appRawRequest(
  testApp: TestApp,
  method: string,
  urlPath: string,
  body: string,
  headers: Record<string, string>,
): Promise<Response> {
  return testApp.app.request(urlPath, { method: method as 'POST', headers, body })
}

async function signForgedToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return sign(
    {
      sub: crypto.randomUUID(),
      sid: crypto.randomUUID(),
      did: 'forged',
      iss: 'bot-backend',
      aud: 'bot-desktop',
      iat: now,
      exp: now + 600,
    },
    'a-completely-different-secret-value-0123456789abcdef',
    'HS256',
  )
}
