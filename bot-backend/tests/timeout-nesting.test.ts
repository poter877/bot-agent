import { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { processingTimeout, scopedProcessingTimeout } from '../src/middleware/timeout.js'
import type { AppEnv } from '../src/shared/context.js'
import { createTestApp, flushRateLimits, jsonRequest, registerUser, truncateAll, uniqueEmail, type TestApp } from './helpers.js'

/**
 * Nested processing budgets. Hono's timeout() arms a racing timer per mount,
 * so a global budget plus a tree-scoped budget used to settle at the SHORTER
 * one: long media generations (budgeted for minutes) died at the global 10s.
 * The scoped mount now settles the budget so the global mount defers; these
 * regressions prove the scoped tree outlives the global budget while an
 * ordinary route still dies at it.
 *
 * Timing skeleton (schema floor is 1000ms for both budgets):
 *   global REQUEST_TIMEOUT_MS = 1000, scoped media budget = 3000,
 *   fake work sleeps 1500ms  →  must be 200, not 503.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const IMAGE_CATALOG = [{ id: 'company-image', provider: 'fal' as const, model: 'fal-image-test', enabled: true }]
const TAVILY_CATALOG = '[{"id":"tavily-main","provider":"tavily","enabled":true}]'

describe('nested processing budgets', () => {
  describe('the real app assembly', () => {
    let testApp: TestApp
    let cookie: string

    beforeAll(async () => {
      testApp = await createTestApp(
        {
          REQUEST_TIMEOUT_MS: '1000',
          MEDIA_REQUEST_TIMEOUT_MS: '3000',
          FAL_KEY: 'test-fal-key',
        },
        undefined,
        undefined,
        {
          imageCatalog: IMAGE_CATALOG,
          imageGenerator: async () => {
            await sleep(1500) // > global 1s, < scoped media 3s
            return [{ media_type: 'image/png', base64: 'AQID' }]
          },
        },
      )
    })

    beforeEach(async () => {
      await truncateAll(testApp.database)
      await flushRateLimits(testApp.redis)
      cookie = (await registerUser(testApp.app, testApp.database, uniqueEmail(), 'password-123456')).cookie
    })

    afterAll(async () => {
      await testApp.close()
    })

    it('lets a media generation outlive the global budget under its scoped budget', async () => {
      const response = await testApp.app.request('/api/media/image', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3100', cookie },
        body: JSON.stringify({ model: 'company-image', prompt: 'slow cat' }),
      })
      expect(response.status).toBe(200)
      expect(((await response.json()) as { ok: boolean }).ok).toBe(true)
    })

    it('still kills a media request that outruns its own scoped budget', async () => {
      // Same app shape except the scoped budget itself is the short one.
      const tight = await createTestApp(
        {
          REQUEST_TIMEOUT_MS: '1000',
          MEDIA_REQUEST_TIMEOUT_MS: '1000',
          FAL_KEY: 'test-fal-key',
        },
        undefined,
        undefined,
        {
          imageCatalog: IMAGE_CATALOG,
          imageGenerator: async () => {
            await sleep(1800) // > both budgets
            return [{ media_type: 'image/png', base64: 'AQID' }]
          },
        },
      )
      try {
        await truncateAll(tight.database)
        await flushRateLimits(tight.redis)
        const user = await registerUser(tight.app, tight.database, uniqueEmail(), 'password-123456')
        const response = await tight.app.request('/api/media/image', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3100', cookie: user.cookie },
          body: JSON.stringify({ model: 'company-image', prompt: 'too slow' }),
        })
        expect(response.status).toBe(503)
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe('request_timeout')
      } finally {
        await tight.close()
      }
    })

    it('lets a tool-gateway vendor call outlive the global budget under its scoped budget', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = async () => {
        await sleep(1500) // > global 1s, < the 20s tools budget
        return new Response(JSON.stringify({ results: [{ title: 't', url: 'https://x.example', content: 's' }] }))
      }
      let tools: TestApp
      try {
        tools = await createTestApp({
          REQUEST_TIMEOUT_MS: '1000',
          TOOLS_SEARCH_CATALOG: TAVILY_CATALOG,
          TAVILY_API_KEY: 'test-tavily-key',
        })
        await truncateAll(tools.database)
        await flushRateLimits(tools.redis)
        const user = await registerUser(tools.app, tools.database, uniqueEmail(), 'password-123456')
        const response = await jsonRequest(tools.app, 'POST', '/api/tools/search', { query: 'slow vendor' }, {
          cookie: user.cookie,
          origin: 'http://127.0.0.1:3100',
        })
        expect(response.status).toBe(200)
        expect(((await response.json()) as { ok: boolean }).ok).toBe(true)
        await tools.close()
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  describe('the middleware pair in isolation', () => {
    it('bounds ordinary routes with the global budget while the scoped tree runs to its own', async () => {
      const mini = new Hono<AppEnv>()
      mini.use('/api/media/*', scopedProcessingTimeout(5000))
      mini.use(processingTimeout(200))
      mini.get('/api/media/thing', async (c) => {
        await sleep(1000) // > global 200ms, < scoped 5s
        return c.json({ ok: true })
      })
      mini.get('/v1/thing', async (c) => {
        await sleep(1000) // > global 200ms and no scoped budget to save it
        return c.json({ ok: true })
      })

      const media = await mini.request('/api/media/thing')
      expect(media.status).toBe(200)

      const ordinary = await mini.request('/v1/thing')
      expect(ordinary.status).toBe(503)
      expect(((await ordinary.json()) as { error: { code: string } }).error.code).toBe('request_timeout')
    })
  })
})
