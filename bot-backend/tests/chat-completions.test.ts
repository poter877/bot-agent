import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { llmRequestLog } from '../src/db/schema.js'
import { createTestApp, flushRateLimits, jsonRequest, registerUser, truncateAll, uniqueEmail, type RegisteredUser, type TestApp } from './helpers.js'

/**
 * Contract tests for POST /api/llm/chat/completions — the OpenAI-compatible
 * dialect for internal services (ai-drama 的 mastra agents). Same admission as
 * the model stream (catalog, quota, request log, usage), service principals
 * only, stream and non-stream shapes per the OpenAI wire protocol.
 */

const CATALOG = [{ id: 'company-default', provider: 'openai' as const, model: 'gpt-test-model', enabled: true }]

const BASE_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 12, noCache: 10, cacheRead: 2, cacheWrite: undefined },
  outputTokens: { total: 5, text: 4, reasoning: 1 },
}

describe('POST /api/llm/chat/completions', () => {
  let testApp: TestApp
  let user: RegisteredUser
  let model: MockLanguageModelV4

  beforeAll(async () => {
    testApp = await createTestApp(
      { OPENAI_API_KEY: 'test-openai-key', MEDIA_SERVICE_TOKEN: 'svc-token-0123456789abcdef' },
      {
        modelResolver: () => {
          if (model === undefined) throw new Error('test model not installed for this request')
          return model
        },
        catalog: CATALOG,
      },
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

  const serviceRequest = (body: unknown): Promise<Response> =>
    testApp.app.request('/api/llm/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer svc-token-0123456789abcdef' },
      body: JSON.stringify(body),
    })

  const textParts = (text: string): LanguageModelV4StreamPart[] => [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text_1' },
    { type: 'text-delta', id: 'text_1', delta: text },
    { type: 'text-end', id: 'text_1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: BASE_USAGE },
  ]

  it('answers a non-streaming completion in the OpenAI response shape', async () => {
    model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text' as const, text: '你好，世界' }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: BASE_USAGE,
        warnings: [],
      }),
      doStream: async () => ({ stream: convertArrayToReadableStream(textParts('你好，世界')) }),
    })

    const response = await serviceRequest({
      model: 'company-default',
      messages: [{ role: 'user', content: '打招呼' }],
      // Gateway-injected fields (new-api 风格) must be tolerated, not 400.
      enable_thinking: false,
      thinking: { type: 'disabled' },
      max_tokens: 1000,
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.object).toBe('chat.completion')
    expect(body.model).toBe('company-default')
    expect(body.choices[0].message.content).toBe('你好，世界')
    expect(body.choices[0].finish_reason).toBe('stop')
    expect(body.usage.prompt_tokens).toBe(12)
    expect(body.usage.completion_tokens).toBe(5)
  })

  it('streams OpenAI chunks terminated by [DONE]', async () => {
    model = new MockLanguageModelV4({
      doStream: async () => ({ stream: convertArrayToReadableStream(textParts('流式输出')) }),
    })

    const response = await serviceRequest({
      model: 'company-default',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const raw = await response.text()
    const dataLines = raw.split('\n').filter((line) => line.startsWith('data: '))
    const chunks = dataLines.slice(0, -1).map((line) => JSON.parse(line.slice('data: '.length)))
    expect(dataLines.at(-1)).toBe('data: [DONE]')
    expect(chunks.every((chunk) => chunk.object === 'chat.completion.chunk')).toBe(true)
    const textChunk = chunks.find((chunk) => chunk.choices[0]?.delta.content !== undefined)
    expect(textChunk.choices[0].delta.content).toBe('流式输出')
    // finish_reason lands on the last choice-bearing chunk; usage follows on an
    // empty-choices chunk per the OpenAI include_usage convention.
    const choiceChunks = chunks.filter((chunk) => chunk.choices.length > 0)
    const finishChunk = choiceChunks[choiceChunks.length - 1]
    expect(finishChunk?.choices[0]?.finish_reason).toBe('stop')
    const usageChunk = chunks[chunks.length - 1]
    expect(usageChunk.choices).toEqual([])
    expect(usageChunk.usage.total_tokens).toBe(17)
  })

  it('maps tool calls into OpenAI tool_calls and records usage + request log', async () => {
    model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          { type: 'tool-call' as const, toolCallId: 'call_1', toolName: 'render_scene', input: { scene: 3 } },
        ],
        finishReason: { unified: 'tool-calls' as const, raw: undefined },
        usage: BASE_USAGE,
        warnings: [],
      }),
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'render_scene', input: { scene: 3 } },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: BASE_USAGE },
        ]),
      }),
    })

    const response = await serviceRequest({
      model: 'company-default',
      messages: [{ role: 'user', content: '渲染第 3 场' }],
      tools: [{ type: 'function', function: { name: 'render_scene', parameters: { type: 'object', properties: {} } } }],
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    const toolCall = body.choices[0].message.tool_calls[0]
    expect(toolCall.function.name).toBe('render_scene')
    expect(JSON.parse(toolCall.function.arguments)).toEqual({ scene: 3 })
    expect(body.choices[0].finish_reason).toBe('tool_calls')

    const [logged] = await testApp.database.db.select().from(llmRequestLog).where(eq(llmRequestLog.modelId, 'company-default'))
    expect(logged).toMatchObject({ status: 'complete', finishReason: 'tool-calls' })
  })

  it('rejects browser sessions — the endpoint is service-principal only', async () => {
    const response = await jsonRequest(
      testApp.app,
      'POST',
      '/api/llm/chat/completions',
      { model: 'company-default', messages: [{ role: 'user', content: 'hi' }] },
      { cookie: user.cookie },
    )
    expect(response.status).toBe(403)
  })

  it('404s unknown catalog ids before any vendor call', async () => {
    model = new MockLanguageModelV4({ doStream: async () => { throw new Error('must not be called') } })
    const response = await serviceRequest({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] })
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe('model_not_found')
  })
})
