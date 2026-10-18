import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { llmRequestLog } from '../src/db/schema.js'
import {
  createTestApp,
  flushRateLimits,
  registerUser,
  truncateAll,
  uniqueEmail,
  type RegisteredUser,
  type TestApp,
} from './helpers.js'

/**
 * X-Correlation-Id contract: the header an authenticated caller (ai-drama
 * film task → hermes gateway turn) sends rides into llm_request_log so the
 * 运营后台 请求 page joins the layers without timestamp guessing. Values are
 * recorded verbatim after shape validation ([A-Za-z0-9._:-], ≤128): invalid
 * or absent headers journal as null, never an error.
 */

const CATALOG = [
  { id: 'company-default', provider: 'openai' as const, model: 'gpt-test', enabled: true },
]

const BASE_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 12, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

function completeModel(): MockLanguageModelV4 {
  const parts: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text_1' },
    { type: 'text-delta', id: 'text_1', delta: '你好' },
    { type: 'text-end', id: 'text_1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: BASE_USAGE },
  ]
  return new MockLanguageModelV4({ doStream: async () => ({ stream: convertArrayToReadableStream(parts) }) })
}

const IMAGE_CATALOG = [{ id: 'company-image', provider: 'fal' as const, model: 'fal-image-test', enabled: true }]

const streamBody = {
  model: 'company-default',
  messages: [{ role: 'user', content: '你好' }],
}

async function journalRows(app: TestApp) {
  return app.database.db.select().from(llmRequestLog)
}

describe('X-Correlation-Id → llm_request_log', () => {
  let testApp: TestApp
  let user: RegisteredUser

  beforeAll(async () => {
    testApp = await createTestApp(
      { OPENAI_API_KEY: 'test-openai-key', FAL_KEY: 'test-fal-key' },
      { catalog: CATALOG, modelResolver: () => completeModel() },
      undefined,
      { imageCatalog: IMAGE_CATALOG, imageGenerator: async () => [{ media_type: 'image/png', base64: 'AQID' }] },
    )
  })

  beforeEach(async () => {
    await truncateAll(testApp.database)
    await flushRateLimits(testApp.redis)
    user = await registerUser(testApp.app, testApp.database, uniqueEmail(), 'password-123456')
  })

  afterAll(async () => {
    await testApp.close()
  })

  const stream = (correlationId?: string) =>
    testApp.app.request('/api/llm/stream', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:3100',
        cookie: user.cookie,
        ...(correlationId !== undefined ? { 'x-correlation-id': correlationId } : {}),
      },
      body: JSON.stringify(streamBody),
    })

  it('records the header on completed model-stream requests', async () => {
    const response = await stream('film-run-42')
    expect(response.status).toBe(200)
    await response.text()

    const rows = await journalRows(testApp)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('complete')
    expect(rows[0]!.correlationId).toBe('film-run-42')
  })

  it('journals null when the header is absent', async () => {
    const response = await stream()
    expect(response.status).toBe(200)
    await response.text()

    const rows = await journalRows(testApp)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.correlationId).toBeNull()
  })

  it('drops values outside [A-Za-z0-9._:-] or over 128 chars, recording null instead', async () => {
    // 'café' exercises non-ASCII that still fits a ByteString header value.
    const invalid = ['film run 42', 'task;drop table', 'café', 'a'.repeat(129), '']
    for (const value of invalid) {
      const response = await stream(value)
      // The header never changes admission: the request itself still succeeds.
      expect(response.status).toBe(200)
      await response.text()
    }

    const rows = await journalRows(testApp)
    expect(rows).toHaveLength(invalid.length)
    expect(rows.every((row) => row.correlationId === null)).toBe(true)
  })

  it('records the header on rejected requests too (unknown model)', async () => {
    const response = await testApp.app.request('/api/llm/stream', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:3100',
        cookie: user.cookie,
        'x-correlation-id': 'film-run-43',
      },
      body: JSON.stringify({ ...streamBody, model: 'nope' }),
    })
    expect(response.status).toBe(404)

    const rows = await journalRows(testApp)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('rejected')
    expect(rows[0]!.correlationId).toBe('film-run-43')
  })

  it('journals media generation requests with the correlation id', async () => {
    const ok = await testApp.app.request('/api/media/image', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:3100',
        cookie: user.cookie,
        'x-correlation-id': 'film-run-44',
      },
      body: JSON.stringify({ model: 'company-image', prompt: '一只猫' }),
    })
    expect(ok.status).toBe(200)
    await ok.json()

    const rejected = await testApp.app.request('/api/media/image', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:3100',
        cookie: user.cookie,
      },
      body: JSON.stringify({ model: 'nope', prompt: '一只猫' }),
    })
    expect(rejected.status).toBe(404)

    const rows = await journalRows(testApp)
    expect(rows).toHaveLength(2)
    const complete = rows.find((row) => row.status === 'complete')
    expect(complete!.modelId).toBe('company-image')
    expect(complete!.correlationId).toBe('film-run-44')
    const rejectedRow = rows.find((row) => row.status === 'rejected')
    expect(rejectedRow!.modelId).toBe('nope')
    expect(rejectedRow!.correlationId).toBeNull()
  })
})
