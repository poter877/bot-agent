import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, flushRateLimits, registerUser, truncateAll, uniqueEmail, type RegisteredUser, type TestApp } from './helpers.js'

/**
 * Contract tests for the managed tool gateway's unified search surface
 * (POST /api/tools/search): the catalog-driven provider walk (priority,
 * request-named ids), server-held Tavily/Brave keys that never touch the
 * wire, the {title,url,snippet} normalization, fail-closed keyless states,
 * per-user budget, and the usage ledger.
 */

const CATALOG = JSON.stringify([
  { id: 'tavily-main', provider: 'tavily', enabled: true, priority: 1 },
  { id: 'brave-main', provider: 'brave', enabled: true, priority: 5 },
  { id: 'brave-backup', provider: 'brave', enabled: false, priority: 9 },
])

interface UpstreamCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

async function searchPost(testApp: TestApp, body: unknown, headers: Record<string, string>): Promise<Response> {
  return await testApp.app.request('/api/tools/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('POST /api/tools/search — catalog walk and vendor hops', () => {
  let testApp: TestApp
  let user: RegisteredUser
  const upstream: UpstreamCall[] = []

  beforeAll(async () => {
    const fakeFetch = vi.fn(async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const url = new URL(String(input))
      upstream.push({
        url: String(url),
        method: init?.method ?? 'GET',
        headers: { ...(init?.headers ?? {}) },
        ...(init?.body !== undefined ? { body: JSON.parse(init.body) } : {}),
      })
      if (url.hostname === 'api.tavily.com') {
        return new Response(
          JSON.stringify({ results: [{ title: 'Tavily hit', url: 'https://t.example/a', content: 'tavily snippet' }] }),
          { status: 200 },
        )
      }
      if (url.hostname === 'api.search.brave.com') {
        return new Response(
          JSON.stringify({ web: { results: [{ title: 'Brave hit', url: 'https://b.example/a', description: 'brave snippet' }] } }),
          { status: 200 },
        )
      }
      return new Response('unexpected', { status: 500 })
    })
    vi.stubGlobal('fetch', fakeFetch)
    testApp = await createTestApp(
      { TOOLS_SEARCH_CATALOG: CATALOG, TAVILY_API_KEY: 'test-tavily-key', BRAVE_API_KEY: 'test-brave-key', MEDIA_SERVICE_TOKEN: 'svc-token-0123456789abcdef' },
      undefined,
      undefined,
      undefined,
    )
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
    await testApp.close()
  })

  beforeEach(async () => {
    upstream.length = 0
    await truncateAll(testApp.database)
    await flushRateLimits(testApp.redis)
    user = await registerUser(testApp.app, testApp.database, uniqueEmail(), 'password-123456')
  })

  it('serves the highest-priority available entry (brave) and normalizes web.results', async () => {
    const response = await searchPost(testApp, { query: 'hello world' }, {
      cookie: user.cookie,
      origin: 'http://127.0.0.1:3100',
      'x-correlation-id': 'task-42',
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; provider: string; results: Array<{ title: string; url: string; snippet: string }> }
    expect(body.ok).toBe(true)
    expect(body.provider).toBe('brave-main')
    expect(body.results).toEqual([{ title: 'Brave hit', url: 'https://b.example/a', snippet: 'brave snippet' }])

    const call = upstream[0]!
    expect(call.url).toBe('https://api.search.brave.com/res/v1/web/search?q=hello+world&count=5')
    expect(call.method).toBe('GET')
    expect(call.headers['X-Subscription-Token']).toBe('test-brave-key')
    // The inbound correlation id rides the vendor hop verbatim (middleware contract).
    expect(call.headers['X-Correlation-Id']).toBe('task-42')
  })

  it('honors a request-named catalog id over the priority walk', async () => {
    const response = await searchPost(testApp, { query: 'hello', limit: 3, provider: 'tavily-main' }, {
      cookie: user.cookie,
      origin: 'http://127.0.0.1:3100',
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; provider: string; results: Array<{ title: string; url: string; snippet: string }> }
    expect(body.provider).toBe('tavily-main')
    expect(body.results).toEqual([{ title: 'Tavily hit', url: 'https://t.example/a', snippet: 'tavily snippet' }])

    const call = upstream[0]!
    expect(call.url).toBe('https://api.tavily.com/search')
    expect(call.method).toBe('POST')
    expect(call.headers['Authorization']).toBe('Bearer test-tavily-key')
    expect(call.body).toEqual({ query: 'hello', max_results: 3 })
  })

  it('counts usage per user/day in the tools ledger', async () => {
    await searchPost(testApp, { query: 'hello' }, {
      cookie: user.cookie,
      origin: 'http://127.0.0.1:3100',
    })
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '')
    const usage = await testApp.redis.commands.hGetAll(`tools:usage:${user.userId}:${day}`)
    expect(usage.requests).toBe('1')
    expect(usage['provider:brave-main']).toBe('1')
  })

  it('demands a session (or service token) and a matching Origin', async () => {
    const noAuth = await searchPost(testApp, { query: 'x' }, {})
    expect(noAuth.status).toBe(401)
    const noOrigin = await searchPost(testApp, { query: 'x' }, { cookie: user.cookie })
    expect(noOrigin.status).toBe(403)
    const service = await searchPost(testApp, { query: 'x' }, { authorization: 'Bearer svc-token-0123456789abcdef' })
    expect(service.status).toBe(200)
  })

  it('validates query and limit before any vendor call', async () => {
    const noQuery = await searchPost(testApp, {}, { cookie: user.cookie, origin: 'http://127.0.0.1:3100' })
    expect(noQuery.status).toBe(400)
    for (const limit of [0, 11, 1.5]) {
      const bad = await searchPost(testApp, { query: 'x', limit }, { cookie: user.cookie, origin: 'http://127.0.0.1:3100' })
      expect(bad.status).toBe(400)
    }
    expect(upstream).toHaveLength(0)
  })

  it('404s unknown catalog ids and 403s disabled ones', async () => {
    const unknown = await searchPost(testApp, { query: 'x', provider: 'nope' }, { cookie: user.cookie, origin: 'http://127.0.0.1:3100' })
    expect(unknown.status).toBe(404)
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe('model_not_found')
    const disabled = await searchPost(testApp, { query: 'x', provider: 'brave-backup' }, { cookie: user.cookie, origin: 'http://127.0.0.1:3100' })
    expect(disabled.status).toBe(403)
    expect(((await disabled.json()) as { error: { code: string } }).error.code).toBe('model_disabled')
    expect(upstream).toHaveLength(0)
  })
})

describe('POST /api/tools/search — fail-closed and vendor failures', () => {
  let testApp: TestApp

  beforeAll(async () => {
    const fakeFetch = vi.fn(async (input: unknown, init?: { body?: string }) => {
      const url = new URL(String(input))
      if (url.hostname === 'api.tavily.com') {
        if (init?.body !== undefined && JSON.parse(init.body).query === 'reject me') {
          return new Response(JSON.stringify({ detail: 'quota exceeded upstream' }), { status: 429 })
        }
        return new Response(
          JSON.stringify({ results: [{ title: 'Tavily hit', url: 'https://t.example/a', content: 'tavily snippet' }] }),
          { status: 200 },
        )
      }
      return new Response('unexpected', { status: 500 })
    })
    vi.stubGlobal('fetch', fakeFetch)
    testApp = await createTestApp(
      { TOOLS_SEARCH_CATALOG: CATALOG, TAVILY_API_KEY: 'test-tavily-key', MEDIA_SERVICE_TOKEN: 'svc-token-0123456789abcdef' },
      undefined,
      undefined,
      undefined,
    )
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
    await testApp.close()
  })

  it('skips keyless entries in the priority walk (no brave key → tavily serves)', async () => {
    const response = await searchPost(testApp, { query: 'x' }, { authorization: 'Bearer svc-token-0123456789abcdef' })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { provider: string }).provider).toBe('tavily-main')
  })

  it('answers 502 with a clean message when the vendor refuses', async () => {
    const response = await searchPost(testApp, { query: 'reject me' }, { authorization: 'Bearer svc-token-0123456789abcdef' })
    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toBe('Web search failed.')
    expect(JSON.stringify(body)).not.toContain('quota exceeded upstream')
  })
})

describe('POST /api/tools/search — without vendor keys', () => {
  let testApp: TestApp

  beforeAll(async () => {
    testApp = await createTestApp(
      { TOOLS_SEARCH_CATALOG: CATALOG, MEDIA_SERVICE_TOKEN: 'svc-token-0123456789abcdef' },
      undefined,
      undefined,
      undefined,
    )
  })

  afterAll(async () => {
    await testApp.close()
  })

  it('fails closed with 503 on the priority walk and on a requested entry', async () => {
    const walked = await searchPost(testApp, { query: 'x' }, { authorization: 'Bearer svc-token-0123456789abcdef' })
    expect(walked.status).toBe(503)
    expect(((await walked.json()) as { error: { code: string } }).error.code).toBe('provider_key_missing')

    const requested = await searchPost(testApp, { query: 'x', provider: 'tavily-main' }, { authorization: 'Bearer svc-token-0123456789abcdef' })
    expect(requested.status).toBe(503)
  })
})

describe('POST /api/tools/search — tools-scope per-user budget', () => {
  let testApp: TestApp
  let user: RegisteredUser

  beforeAll(async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ title: 't', url: 'https://x.example', content: 's' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fakeFetch)
    testApp = await createTestApp(
      { TOOLS_SEARCH_CATALOG: CATALOG, TAVILY_API_KEY: 'test-tavily-key', RATE_LIMIT_TOOLS_MAX: '2', MEDIA_SERVICE_TOKEN: 'svc-token-0123456789abcdef' },
      undefined,
      undefined,
      undefined,
    )
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
    await testApp.close()
  })

  beforeEach(async () => {
    await truncateAll(testApp.database)
    await flushRateLimits(testApp.redis)
    user = await registerUser(testApp.app, testApp.database, uniqueEmail(), 'password-123456')
  })

  it('answers 429 once the per-user tools budget is spent', async () => {
    const headers = { cookie: user.cookie, origin: 'http://127.0.0.1:3100' }
    expect((await searchPost(testApp, { query: 'a' }, headers)).status).toBe(200)
    expect((await searchPost(testApp, { query: 'b' }, headers)).status).toBe(200)
    const throttled = await searchPost(testApp, { query: 'c' }, headers)
    expect(throttled.status).toBe(429)
    expect(throttled.headers.get('retry-after')).not.toBeNull()
  })
})
