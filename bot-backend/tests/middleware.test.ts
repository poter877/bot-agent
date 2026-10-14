import { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { processingTimeout } from '../src/middleware/timeout.js'
import {
  createTestApp,
  flushRateLimits,
  jsonRequest,
  registerUser,
  signIn,
  truncateAll,
  uniqueEmail,
  type TestApp,
} from './helpers.js'

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
    const malformed = await testApp.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"email": "a@b.c",,',
    })
    expect(malformed.status).toBe(400)
    expect(((await malformed.json()) as { error: { code: string } }).error.code).toBe('invalid_json')

    const wrongType = await testApp.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=1',
    })
    expect(wrongType.status).toBe(415)
    expect(((await wrongType.json()) as { error: { code: string } }).error.code).toBe('unsupported_media_type')
  })

  it('enforces the 16 KiB body budget with 413', async () => {
    const oversized = await jsonRequest(testApp.app, 'POST', '/api/auth/sign-in/email', {
      email: uniqueEmail(),
      password: 'x'.repeat(17 * 1024),
    })
    expect(oversized.status).toBe(413)
    expect(((await oversized.json()) as { error: { code: string } }).error.code).toBe('payload_too_large')
  })

  it('rejects /v1 without a valid session cookie', async () => {
    const none = await jsonRequest(testApp.app, 'GET', '/v1/users/me')
    expect(none.status).toBe(401)
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe('unauthorized')
  })

  it('applies the shared entry budget across every guarded tree', async () => {
    const limited = await createTestApp({ RATE_LIMIT_ENTRY_MAX: '3' })
    try {
      await flushRateLimits(limited.redis)
      const statuses: number[] = []
      for (let i = 0; i < 5; i += 1) {
        const health = await jsonRequest(limited.app, 'GET', '/healthz') // outside both trees
        expect(health.status).toBe(200)
        const guarded = await jsonRequest(limited.app, 'GET', '/api/auth/get-session')
        statuses.push(guarded.status)
      }
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200])
      expect(statuses.slice(3)).toEqual([429, 429])
    } finally {
      await limited.close()
    }
  })

  it('fails closed with 503 when Redis cannot answer', async () => {
    const brokenRedis = await createTestApp({ REDIS_URL: 'redis://127.0.0.1:1' })
    try {
      const response = await signIn(brokenRedis.app, uniqueEmail(), 'whatever-pass')
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

  it('exposes register/login only through the library handler', async () => {
    // The service must not grow its own account endpoints beside Better Auth;
    // unknown /v1 paths answer 401 like the rest of the guarded tree.
    const ownRegister = await jsonRequest(testApp.app, 'POST', '/v1/auth/register', {
      email: uniqueEmail(),
      password: 'whatever-pass',
    })
    expect(ownRegister.status).toBe(401)
    const ownLogin = await jsonRequest(testApp.app, 'POST', '/v1/auth/login', {
      email: uniqueEmail(),
      password: 'whatever-pass',
    })
    expect(ownLogin.status).toBe(401)
  })

  it('keeps a working end-to-end account round trip through the library', async () => {
    const email = uniqueEmail()
    await registerUser(testApp.app, testApp.database, email, 'correct-horse-battery')
    const relogin = await signIn(testApp.app, email, 'correct-horse-battery')
    expect(relogin.status).toBe(200)
  })
})
