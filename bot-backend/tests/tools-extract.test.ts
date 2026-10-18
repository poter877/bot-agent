import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, flushRateLimits, registerUser, truncateAll, uniqueEmail, type RegisteredUser, type TestApp } from './helpers.js'

/**
 * Contract tests for the managed tool gateway's web extraction surface
 * (POST /api/tools/extract): the catalog-driven provider walk (priority,
 * request-named ids), server-held Firecrawl/Jina keys that never touch the
 * wire, the {ok,url,format,content,truncated} normalization, in-budget
 * server-side truncation, fail-closed keyless states, and the usage ledger.
 */

const CATALOG = JSON.stringify([
  { id: 'jina-main', provider: 'jina', enabled: true, priority: 1 },
  { id: 'firecrawl-main', provider: 'firecrawl', enabled: true, priority: 5 },
  { id: 'firecrawl-backup', provider: 'firecrawl', enabled: false, priority: 9 },
])

interface UpstreamCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

const FIRECRAWL_MARKDOWN = '# Firecrawl page\n\nserved by the scrape API'
const FIRECRAWL_HTML = '<html><body><h1>Firecrawl page</h1></body></html>'
const JINA_BODY = 'Title: Jina page\nURL Source: https://example.com/page\nMarkdown Content:\n# Jina page body'

async function extractPost(testApp: TestApp, body: unknown, headers: Record<string, string>): Promise<Response> {
  return await testApp.app.request('/api/tools/extract', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('POST /api/tools/extract — catalog walk and vendor hops', () => {
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
      if (url.hostname === 'api.firecrawl.dev') {
        const target = init?.body !== undefined ? String(JSON.parse(init.body).url) : ''
        if (target === 'https://example.com/long') {
          return new Response(
            JSON.stringify({ success: true, data: { markdown: `# Long page\n\n${'word '.repeat(200)}` } }),
            { status: 200 },
          )
        }
        return new Response(
          JSON.stringify({ success: true, data: { markdown: FIRECRAWL_MARKDOWN, html: FIRECRAWL_HTML, metadata: { sourceURL: 'https://example.com/page' } } }),
          { status: 200 },
        )
      }
      if (url.hostname === 'r.jina.ai') {
        return new Response(JINA_BODY, { status: 200 })
      }
      return new Response('unexpected', { status: 500 })
    })
    vi.stubGlobal('fetch', fakeFetch)
    testApp = await createTestApp(
      { TOOLS_EXTRACT_CATALOG: CATALOG, FIRECRAWL_API_KEY: 'test-firecrawl-key', JINA_API_KEY: 'test-jina-key', MEDIA_SERVICE_TOKEN: 'svc-token-0123456789abcdef' },
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

  it('serves the highest-priority available entry (firecrawl) and normalizes data.markdown', async () => {
    const response = await extractPost(testApp, { url: 'https://example.com/page' }, {
      cookie: user.cookie,
      origin: 'http://127.0.0.1:3100',
      'x-correlation-id': 'task-42',
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; url: string; format: string; content: string; truncated: boolean }
    expect(body).toEqual({ ok: true, url: 'https://example.com/page', format: 'markdown', content: FIRECRAWL_MARKDOWN, truncated: false })

    const call = upstream[0]!
    expect(call.url).toBe('https://api.firecrawl.dev/v1/scrape')
    expect(call.method).toBe('POST')
    expect(call.headers['Authorization']).toBe('Bearer test-firecrawl-key')
    expect(call.body).toEqual({ url: 'https://example.com/page', formats: ['markdown'] })
    // The inbound correlation id rides the vendor hop verbatim (middleware contract).
    expect(call.headers['X-Correlation-Id']).toBe('task-42')
  })

  it('honors a request-named catalog id over the priority walk (jina body is the content)', async () => {
    const response = await extractPost(testApp, { url: 'https://example.com/page', provider: 'jina-main' }, {
      cookie: user.cookie,
      origin: 'http://127.0.0.1:3100',
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; content: string; truncated: boolean }
    expect(body.ok).toBe(true)
    expect(body.content).toBe(JINA_BODY)
    expect(body.truncated).toBe(false)

    const call = upstream[0]!
    // The target URL rides the reader route verbatim (never encoded).
    expect(call.url).toBe(`https://r.jina.ai/https://example.com/page`)
    expect(call.method).toBe('GET')
    expect(call.headers['Authorization']).toBe('Bearer test-jina-key')
    expect(call.headers['X-Return-Format']).toBe('markdown')
  })

  it('asks firecrawl for html and picks data.html when format=html', async () => {
    const response = await extractPost(testApp, { url: 'https://example.com/page', format: 'html' }, {
      cookie: user.cookie,
      origin: 'http://127.0.0.1:3100',
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { format: string; content: string }
    expect(body.format).toBe('html')
    expect(body.content).toBe(FIRECRAWL_HTML)
    expect(upstream[0]!.body).toEqual({ url: 'https://example.com/page', formats: ['html'] })
  })

  it('truncates over-budget content server-side and marks it inside the budget', async () => {
    const response = await extractPost(testApp, { url: 'https://example.com/long', maxChars: 300 }, {
      cookie: user.cookie,
      origin: 'http://127.0.0.1:3100',
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { content: string; truncated: boolean }
    expect(body.truncated).toBe(true)
    expect(body.content.length).toBeLessThanOrEqual(300)
    expect(body.content).toContain('truncated server-side at 300 chars')
  })

  it('counts usage per user/day in the shared tools ledger', async () => {
    await extractPost(testApp, { url: 'https://example.com/page' }, {
      cookie: user.cookie,
      origin: 'http://127.0.0.1:3100',
    })
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '')
    const usage = await testApp.redis.commands.hGetAll(`tools:usage:${user.userId}:${day}`)
    expect(usage.requests).toBe('1')
    expect(usage['provider:firecrawl-main']).toBe('1')
  })

  it('demands a session (or service token) and a matching Origin', async () => {
    const noAuth = await extractPost(testApp, { url: 'https://example.com/page' }, {})
    expect(noAuth.status).toBe(401)
    const noOrigin = await extractPost(testApp, { url: 'https://example.com/page' }, { cookie: user.cookie })
    expect(noOrigin.status).toBe(403)
    const service = await extractPost(testApp, { url: 'https://example.com/page' }, { authorization: 'Bearer svc-token-0123456789abcdef' })
    expect(service.status).toBe(200)
  })

  it('validates url, format and maxChars before any vendor call', async () => {
    const headers = { cookie: user.cookie, origin: 'http://127.0.0.1:3100' }
    for (const body of [
      {},
      { url: '' },
      { url: 'not a url' },
      { url: 'ftp://example.com/file' },
      { url: 'https://user:pass@example.com/page' },
      { url: `https://example.com/${'a'.repeat(2_100)}` },
      { url: 'https://example.com/page', format: 'pdf' },
      { url: 'https://example.com/page', maxChars: 0 },
      { url: 'https://example.com/page', maxChars: 100_001 },
      { url: 'https://example.com/page', maxChars: 1.5 },
    ]) {
      const bad = await extractPost(testApp, body, headers)
      expect(bad.status, JSON.stringify(body)).toBe(400)
    }
    expect(upstream).toHaveLength(0)
  })

  it('404s unknown catalog ids and 403s disabled ones', async () => {
    const headers = { cookie: user.cookie, origin: 'http://127.0.0.1:3100' }
    const unknown = await extractPost(testApp, { url: 'https://example.com/page', provider: 'nope' }, headers)
    expect(unknown.status).toBe(404)
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe('model_not_found')
    const disabled = await extractPost(testApp, { url: 'https://example.com/page', provider: 'firecrawl-backup' }, headers)
    expect(disabled.status).toBe(403)
    expect(((await disabled.json()) as { error: { code: string } }).error.code).toBe('model_disabled')
    expect(upstream).toHaveLength(0)
  })
})

describe('POST /api/tools/extract — fail-closed and vendor failures', () => {
  let testApp: TestApp

  beforeAll(async () => {
    const fakeFetch = vi.fn(async (input: unknown, init?: { body?: string }) => {
      const url = new URL(String(input))
      if (url.hostname === 'api.firecrawl.dev') {
        if (init?.body !== undefined && JSON.parse(init.body).url === 'https://example.com/refuse') {
          return new Response(JSON.stringify({ error: 'firecrawl quota exhausted upstream' }), { status: 402 })
        }
        if (init?.body !== undefined && JSON.parse(init.body).url === 'https://example.com/empty') {
          return new Response(JSON.stringify({ success: true, data: { metadata: {} } }), { status: 200 })
        }
        return new Response(
          JSON.stringify({ success: true, data: { markdown: FIRECRAWL_MARKDOWN } }),
          { status: 200 },
        )
      }
      return new Response('unexpected', { status: 500 })
    })
    vi.stubGlobal('fetch', fakeFetch)
    testApp = await createTestApp(
      { TOOLS_EXTRACT_CATALOG: CATALOG, FIRECRAWL_API_KEY: 'test-firecrawl-key', JINA_API_KEY: 'test-jina-key', MEDIA_SERVICE_TOKEN: 'svc-token-0123456789abcdef' },
      undefined,
      undefined,
      undefined,
    )
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
    await testApp.close()
  })

  it('answers 502 with a clean message when the vendor refuses', async () => {
    const response = await extractPost(testApp, { url: 'https://example.com/refuse' }, { authorization: 'Bearer svc-token-0123456789abcdef' })
    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toBe('Web extraction failed.')
    expect(JSON.stringify(body)).not.toContain('quota exhausted upstream')
  })

  it('answers 502 when the vendor payload carries no page content', async () => {
    const response = await extractPost(testApp, { url: 'https://example.com/empty' }, { authorization: 'Bearer svc-token-0123456789abcdef' })
    expect(response.status).toBe(502)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('internal_error')
  })
})

describe('POST /api/tools/extract — without vendor keys', () => {
  let testApp: TestApp

  beforeAll(async () => {
    testApp = await createTestApp(
      { TOOLS_EXTRACT_CATALOG: CATALOG, JINA_API_KEY: 'test-jina-key', MEDIA_SERVICE_TOKEN: 'svc-token-0123456789abcdef' },
      undefined,
      undefined,
      undefined,
    )
  })

  afterAll(async () => {
    await testApp.close()
  })

  it('skips keyless entries in the priority walk (no firecrawl key → jina serves)', async () => {
    const fakeFetch = vi.fn(async () => new Response(JINA_BODY, { status: 200 }))
    vi.stubGlobal('fetch', fakeFetch)
    try {
      const response = await extractPost(testApp, { url: 'https://example.com/page' }, { authorization: 'Bearer svc-token-0123456789abcdef' })
      expect(response.status).toBe(200)
      expect(fakeFetch).toHaveBeenCalledWith('https://r.jina.ai/https://example.com/page', expect.anything())
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fails closed with 503 when no entry holds a key at all', async () => {
    const keyless = await createTestApp(
      { TOOLS_EXTRACT_CATALOG: CATALOG, MEDIA_SERVICE_TOKEN: 'svc-token-0123456789abcdef' },
      undefined,
      undefined,
      undefined,
    )
    try {
      const walked = await extractPost(keyless, { url: 'https://example.com/page' }, { authorization: 'Bearer svc-token-0123456789abcdef' })
      expect(walked.status).toBe(503)
      expect(((await walked.json()) as { error: { code: string } }).error.code).toBe('provider_key_missing')

      const requested = await extractPost(keyless, { url: 'https://example.com/page', provider: 'jina-main' }, { authorization: 'Bearer svc-token-0123456789abcdef' })
      expect(requested.status).toBe(503)
    } finally {
      await keyless.close()
    }
  })
})
