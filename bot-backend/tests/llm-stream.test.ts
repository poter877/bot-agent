import { convertArrayToReadableStream, MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { toSerializablePart } from '../src/modules/llm/sse.js'
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
 * Contract tests for POST /api/llm/stream (doc《流式服务端重构》§4/§8): auth
 * and catalog gates never reach a vendor call, the AI SDK Core full event
 * feed is forwarded as SSE frames with a monotonic id sequence, and every
 * failure mode surfaces as an explicit status or an explicit stream event.
 */

const CATALOG = [
  { id: 'company-default', provider: 'openai' as const, model: 'gpt-test', enabled: true, maxOutputTokens: 100 },
  { id: 'company-anthropic', provider: 'anthropic' as const, model: 'claude-test', enabled: true },
  { id: 'company-disabled', provider: 'openai' as const, model: 'gpt-off', enabled: false },
]

const BASE_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 12, noCache: 10, cacheRead: 2, cacheWrite: undefined },
  outputTokens: { total: 5, text: 4, reasoning: 1 },
  totalTokens: 17,
}

interface MockModelSetup {
  model: MockLanguageModelV4
  callOptions: LanguageModelV4CallOptions[]
}

function mockModel(parts: LanguageModelV4StreamPart[], options: { chunkDelayMs?: number } = {}): MockModelSetup {
  const callOptions: LanguageModelV4CallOptions[] = []
  const model = new MockLanguageModelV4({
    doStream: async (nextCallOptions) => {
      callOptions.push(nextCallOptions)
      return {
        stream:
          options.chunkDelayMs === undefined
            ? convertArrayToReadableStream(parts)
            : simulateReadableStream({ chunks: parts, initialDelayMs: 5, chunkDelayMs: options.chunkDelayMs }),
      }
    },
  })
  return { model, callOptions }
}

/** Test seam holder: the app resolves models through this indirection. */
function resolverHolder() {
  const holder: { model?: MockLanguageModelV4 } = {}
  return {
    holder,
    resolver: () => {
      if (holder.model === undefined) throw new Error('test model not installed for this request')
      return holder.model
    },
  }
}

interface SseEvent {
  event: string
  id: string | null
  data: unknown
}

function parseSse(body: string): SseEvent[] {
  const events: SseEvent[] = []
  for (const block of body.split('\n\n')) {
    if (block.trim() === '') continue
    let event = 'message'
    let id: string | null = null
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue
      if (line.startsWith('event: ')) event = line.slice('event: '.length)
      else if (line.startsWith('id: ')) id = line.slice('id: '.length)
      else if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length))
    }
    if (dataLines.length === 0) continue
    events.push({ event, id, data: JSON.parse(dataLines.join('\n')) })
  }
  return events
}

function sseRequest(app: TestApp['app'], user: RegisteredUser, body: unknown): Promise<Response> {
  return app.request('/api/llm/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3100', cookie: user.cookie },
    body: JSON.stringify(body),
  })
}

const textBody = {
  model: 'company-default',
  system: 'You are helpful.',
  messages: [{ role: 'user', content: '你好' }],
}

function callOptionsOf(setup: MockModelSetup): LanguageModelV4CallOptions {
  return setup.callOptions[0]!
}

describe('POST /api/llm/stream — gates before headers', () => {
  let testApp: TestApp

  beforeAll(async () => {
    testApp = await createTestApp({ OPENAI_API_KEY: 'test-openai-key', ANTHROPIC_API_KEY: 'test-anthropic-key' }, { catalog: CATALOG })
  })

  beforeEach(async () => {
    await truncateAll(testApp.database)
    await flushRateLimits(testApp.redis)
  })

  afterAll(async () => {
    await testApp.close()
  })

  it('demands a Better Auth session and never resolves a model without one', async () => {
    const seam = resolverHolder()
    const gated = await createTestApp({ OPENAI_API_KEY: 'k' }, { catalog: CATALOG, modelResolver: seam.resolver })
    const response = await jsonRequest(gated.app, 'POST', '/api/llm/stream', textBody, {
      origin: 'http://127.0.0.1:3100',
    })
    expect(response.status).toBe(401)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('unauthorized')
    expect(seam.holder.model).toBeUndefined()
    await gated.close()
  })

  it('rejects cookie-authed mutations whose Origin does not match the backend', async () => {
    const user = await registerUser(testApp.app, testApp.database, uniqueEmail(), 'password-123456')
    const missing = await testApp.app.request('/api/llm/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: user.cookie },
      body: JSON.stringify(textBody),
    })
    expect(missing.status).toBe(403)
    const foreign = await testApp.app.request('/api/llm/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie: user.cookie },
      body: JSON.stringify(textBody),
    })
    expect(foreign.status).toBe(403)
  })

  it('404s unknown catalog ids and 403s disabled ones without touching a provider', async () => {
    const seam = resolverHolder()
    const gated = await createTestApp({ OPENAI_API_KEY: 'k' }, { catalog: CATALOG, modelResolver: seam.resolver })
    const user = await registerUser(gated.app, gated.database, uniqueEmail(), 'password-123456')
    const unknown = await sseRequest(gated.app, user, { ...textBody, model: 'not-in-catalog' })
    expect(unknown.status).toBe(404)
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe('model_not_found')
    const disabled = await sseRequest(gated.app, user, { ...textBody, model: 'company-disabled' })
    expect(disabled.status).toBe(403)
    expect(((await disabled.json()) as { error: { code: string } }).error.code).toBe('model_disabled')
    expect(seam.holder.model).toBeUndefined()
    await gated.close()
  })

  it('503s when the catalog entry references a provider with no server-side key', async () => {
    const seam = resolverHolder()
    const unkeyed = await createTestApp({}, { catalog: CATALOG, modelResolver: seam.resolver })
    const user = await registerUser(unkeyed.app, unkeyed.database, uniqueEmail(), 'password-123456')
    const response = await sseRequest(unkeyed.app, user, { ...textBody, model: 'company-default' })
    expect(response.status).toBe(503)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('provider_key_missing')
    expect(seam.holder.model).toBeUndefined()
    await unkeyed.close()
  })

  it('maps malformed bodies to explicit 400s', async () => {
    const user = await registerUser(testApp.app, testApp.database, uniqueEmail(), 'password-123456')
    const notJson = await testApp.app.request('/api/llm/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3100', cookie: user.cookie },
      body: '{not json',
    })
    expect(notJson.status).toBe(400)
    expect(((await notJson.json()) as { error: { code: string } }).error.code).toBe('invalid_json')

    const unknownField = await sseRequest(testApp.app, user, { ...textBody, top_k: 5 })
    expect(unknownField.status).toBe(400)
    expect(((await unknownField.json()) as { error: { code: string } }).error.code).toBe('validation_failed')

    const badMessage = await sseRequest(testApp.app, user, {
      model: 'company-default',
      messages: [
        { role: 'system', content: 'system role is reserved for the top-level system field' },
        { role: 'user', content: '你好' },
      ],
    })
    expect(badMessage.status).toBe(400)
    expect(((await badMessage.json()) as { error: { code: string } }).error.code).toBe('validation_failed')
  })
})

describe('POST /api/llm/stream — SSE contract', () => {
  let testApp: TestApp
  const seam = resolverHolder()

  beforeAll(async () => {
    testApp = await createTestApp({ OPENAI_API_KEY: 'test-openai-key' }, { catalog: CATALOG, modelResolver: seam.resolver })
  })

  beforeEach(async () => {
    await truncateAll(testApp.database)
    await flushRateLimits(testApp.redis)
    seam.holder.model = undefined
  })

  afterAll(async () => {
    await testApp.close()
  })

  it('streams text deltas with versioned headers, monotonic ids and a clean end sentinel', async () => {
    const user = await registerUser(testApp.app, testApp.database, uniqueEmail(), 'password-123456')
    seam.holder.model = mockModel([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'text_1' },
      { type: 'text-delta', id: 'text_1', delta: '你好' },
      { type: 'text-delta', id: 'text_1', delta: '，世界' },
      { type: 'text-end', id: 'text_1' },
      { type: 'finish', finishReason: { unified: 'stop' }, usage: BASE_USAGE },
    ]).model
    const response = await sseRequest(testApp.app, user, textBody)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.get('x-model-stream-version')).toBe('1')
    const requestId = response.headers.get('x-request-id')
    expect(requestId).toMatch(/[\w-]{10,}/)

    const events = parseSse(await response.text())
    const aiSdk = events.filter((candidate) => candidate.event === 'ai-sdk')
    // streamText turns the provider feed into the Core part feed: start +
    // start-step open, finish-step + finish close (doc §4.2 full event feed).
    expect(aiSdk.map((candidate) => (candidate.data as { type: string }).type)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ])
    expect(aiSdk.map((candidate) => candidate.id)).toEqual(aiSdk.map((_, index) => `${requestId}:${index + 1}`))
    expect(aiSdk[3]!.data).toEqual({ type: 'text-delta', id: 'text_1', text: '你好' })
    // Core finish: finishReason + totalUsage in the flat LanguageModelUsage shape.
    const finish = aiSdk[7]!.data as {
      type: string
      finishReason: string
      totalUsage: { inputTokens: number; inputTokenDetails: Record<string, number> }
    }
    expect(finish.finishReason).toBe('stop')
    expect(finish.totalUsage.inputTokens).toBe(12)
    expect(finish.totalUsage.inputTokenDetails.cacheReadTokens).toBe(2)
    const end = events[events.length - 1]!
    expect(end.event).toBe('end')
    expect(end.data).toEqual({ request_id: requestId, status: 'complete' })
  })

  it('forwards tool calls with complete inputs the client can validate and execute locally', async () => {
    const user = await registerUser(testApp.app, testApp.database, uniqueEmail(), 'password-123456')
    const setup = mockModel([
      { type: 'stream-start', warnings: [] },
      { type: 'tool-input-start', id: 'call_1', toolName: 'get_weather' },
      { type: 'tool-input-delta', id: 'call_1', delta: '{"city":' },
      { type: 'tool-input-delta', id: 'call_1', delta: '"北京"}' },
      { type: 'tool-input-end', id: 'call_1' },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: JSON.stringify({ city: '北京' }) },
      { type: 'finish', finishReason: { unified: 'tool-calls' }, usage: BASE_USAGE },
    ])
    seam.holder.model = setup.model
    const response = await sseRequest(testApp.app, user, {
      model: 'company-default',
      messages: [{ role: 'user', content: '天气如何？' }],
      tools: [
        {
          name: 'get_weather',
          description: 'Query the weather',
          inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      ],
    })
    const events = parseSse(await response.text())
    const types = events
      .filter((candidate) => candidate.event === 'ai-sdk')
      .map((candidate) => (candidate.data as { type: string }).type)
    expect(types).toEqual([
      'start',
      'start-step',
      'tool-input-start',
      'tool-input-delta',
      'tool-input-delta',
      'tool-input-end',
      'tool-call',
      'finish-step',
      'finish',
    ])
    const call = events.find((candidate) => (candidate.data as { type: string }).type === 'tool-call')
    expect(call!.data).toMatchObject({ type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: { city: '北京' } })
    const finish = events.find((candidate) => (candidate.data as { type: string }).type === 'finish')
    expect((finish!.data as { finishReason: string }).finishReason).toBe('tool-calls')
    // The declared tool schema reached the vendor call as a schema-only tool.
    const tool = callOptionsOf(setup).tools?.find((candidate) => candidate.type === 'function')
    expect(tool).toMatchObject({ name: 'get_weather', inputSchema: { type: 'object' } })
  })

  it('clamps maxOutputTokens to the catalog ceiling and forwards whitelisted parameters', async () => {
    const user = await registerUser(testApp.app, testApp.database, uniqueEmail(), 'password-123456')
    const setup = mockModel([{ type: 'stream-start', warnings: [] }, { type: 'finish', finishReason: { unified: 'length' }, usage: BASE_USAGE }])
    seam.holder.model = setup.model
    const response = await sseRequest(testApp.app, user, {
      ...textBody,
      temperature: 0.5,
      topP: 0.9,
      maxOutputTokens: 5000,
      stopSequences: ['END'],
      seed: 7,
    })
    await response.text()
    const options = callOptionsOf(setup)
    expect(options.temperature).toBe(0.5)
    expect(options.topP).toBe(0.9)
    expect(options.maxOutputTokens).toBe(100)
    expect(options.stopSequences).toEqual(['END'])
    expect(options.seed).toBe(7)
  })

  it('reports model errors as sanitized error events plus a failed end sentinel', async () => {
    const user = await registerUser(testApp.app, testApp.database, uniqueEmail(), 'password-123456')
    const failure = Object.assign(new Error('upstream exploded'), { statusCode: 502 })
    seam.holder.model = mockModel([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'partial' },
      { type: 'text-end', id: 't' },
      { type: 'error', error: failure },
    ]).model
    const response = await sseRequest(testApp.app, user, textBody)
    const events = parseSse(await response.text())
    const errorPart = events.find((candidate) => (candidate.data as { type: string }).type === 'error')
    expect(errorPart!.data).toEqual({ type: 'error', error: { message: 'upstream exploded', status: 502 } })
    expect(JSON.stringify(errorPart!.data)).not.toContain('stack')
    const end = events[events.length - 1]!
    expect(end.event).toBe('end')
    expect(end.data).toEqual({
      request_id: response.headers.get('x-request-id'),
      status: 'failed',
      error: { message: 'The model reported an error.' },
    })
  })

  it('aborts the upstream when the client disconnects and releases the concurrency slot', async () => {
    const user = await registerUser(testApp.app, testApp.database, uniqueEmail(), 'password-123456')
    seam.holder.model = mockModel([{ type: 'stream-start', warnings: [] }], { chunkDelayMs: 30_000 }).model
    const controller = new AbortController()
    const response = await testApp.app.request('/api/llm/stream', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3100', cookie: user.cookie },
      body: JSON.stringify(textBody),
    })
    expect(response.status).toBe(200)
    controller.abort()
    await response.body!.cancel()
    // The release path is asynchronous; the slot must return so a retry is admitted.
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    seam.holder.model = mockModel([{ type: 'stream-start', warnings: [] }, { type: 'finish', finishReason: { unified: 'stop' }, usage: BASE_USAGE }]).model
    const again = await sseRequest(testApp.app, user, textBody)
    expect(again.status).toBe(200)
    await again.text()
  })
})

describe('POST /api/llm/stream — budgets', () => {
  let testApp: TestApp
  const seam = resolverHolder()

  beforeAll(async () => {
    testApp = await createTestApp(
      {
        OPENAI_API_KEY: 'test-openai-key',
        RATE_LIMIT_LLM_STREAM_MAX: '10',
        RATE_LIMIT_LLM_STREAM_WINDOW_SECONDS: '60',
        LLM_STREAM_MAX_CONCURRENT_PER_USER: '1',
      },
      { catalog: CATALOG, modelResolver: seam.resolver },
    )
  })

  beforeEach(async () => {
    await truncateAll(testApp.database)
    await flushRateLimits(testApp.redis)
    seam.holder.model = undefined
  })

  afterAll(async () => {
    await testApp.close()
  })

  it('429s past the concurrent-stream cap while a stream is in flight', async () => {
    const user = await registerUser(testApp.app, testApp.database, uniqueEmail(), 'password-123456')
    seam.holder.model = mockModel([{ type: 'stream-start', warnings: [] }], { chunkDelayMs: 30_000 }).model
    // Hold the first stream open across the probe below, mirroring a live
    // client: the disconnect aborts the request signal.
    const controller = new AbortController()
    const first = await testApp.app.request('/api/llm/stream', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3100', cookie: user.cookie },
      body: JSON.stringify(textBody),
    })
    expect(first.status).toBe(200)

    seam.holder.model = mockModel([{ type: 'stream-start', warnings: [] }, { type: 'finish', finishReason: { unified: 'stop' }, usage: BASE_USAGE }]).model
    const second = await sseRequest(testApp.app, user, textBody)
    expect(second.status).toBe(429)
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe('concurrency_limit')

    controller.abort()
    await first.body!.cancel()
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    const retried = await sseRequest(testApp.app, user, textBody)
    expect(retried.status).toBe(200)
    await retried.text()
  })

  it('records upstream usage per user and day in redis', async () => {
    const user = await registerUser(testApp.app, testApp.database, uniqueEmail(), 'password-123456')
    seam.holder.model = mockModel([{ type: 'stream-start', warnings: [] }, { type: 'finish', finishReason: { unified: 'stop' }, usage: BASE_USAGE }]).model
    const response = await sseRequest(testApp.app, user, textBody)
    await response.text()
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '')
    const usage = await testApp.redis.commands.hGetAll(`llm:usage:${user.userId}:${day}`)
    expect(usage.input_tokens).toBe('12')
    expect(usage.output_tokens).toBe('5')
    expect(usage.total_tokens).toBe('17')
    expect(usage.cache_read_tokens).toBe('2')
    expect(usage['model:company-default']).toBe('1')
  })
})

describe('toSerializablePart — version 1 unsupported surface', () => {
  it('marks binary file parts as explicit unsupported without shipping bytes', () => {
    const marker = toSerializablePart({
      type: 'file',
      file: { mediaType: 'image/png', uint8Array: new Uint8Array([1, 2, 3]), base64: 'AQID' },
    } as Parameters<typeof toSerializablePart>[0])
    expect(marker).toEqual({ type: 'unsupported', originalType: 'file', detail: { mediaType: 'image/png', size: 3 } })
    expect(JSON.stringify(marker)).not.toContain('AQID')
  })

  it('sanitizes error parts to a serializable, bounded shape', () => {
    const failure = Object.assign(new Error('db down'), { statusCode: 503, stack: 'secret-stack' })
    const part = toSerializablePart({ type: 'error', error: failure } as Parameters<typeof toSerializablePart>[0])
    expect(part).toEqual({ type: 'error', error: { message: 'db down', status: 503 } })
    expect(JSON.stringify(part)).not.toContain('secret-stack')
  })

  it('marks raw vendor payloads instead of forwarding them', () => {
    expect(toSerializablePart({ type: 'raw', rawValue: { anything: true } } as Parameters<typeof toSerializablePart>[0])).toEqual({
      type: 'unsupported',
      originalType: 'raw',
      detail: {},
    })
  })
})
