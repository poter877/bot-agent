/**
 * company-llm-model — 直连 bot-backend /api/llm/stream 的自定义 AI SDK provider。
 *
 * mock fetch 返回构造好的 SSE Response，锁定四个契约面：
 * 请求体形状（对齐 llmStreamRequestSchema）、Core→V3 part 映射、
 * 终止帧语义（failed ≠ complete）、非 200 的错误路径。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LanguageModelV3CallOptions } from '@ai-sdk/provider'
import { createCompanyLanguageModel } from '../src/services/company-llm-model.js'

const BASE_URL = 'https://company.invalid/api/llm'

/** 按 bot-backend sse.ts renderFrame 的线格式拼一帧。 */
function frame(event: string, id: string | null, data: unknown): string {
  let out = ''
  if (id !== null) out += `id: ${id}\n`
  out += `event: ${event}\n`
  for (const line of JSON.stringify(data).split('\n')) out += `data: ${line}\n`
  return `${out}\n`
}

function sseResponse(chunks: string[], status = 200): Response {
  return new Response(chunks.join(''), {
    status,
    headers: { 'content-type': status === 200 ? 'text/event-stream; charset=utf-8' : 'application/json' },
  })
}

interface CapturedRequest {
  url: string
  init: RequestInit
}

function mockFetch(response: Response | Promise<Response>, captured: CapturedRequest[] = []): typeof fetch {
  return async (input: any, init?: any) => {
    captured.push({ url: String(input), init })
    return await response
  }
}

async function collect(stream: ReadableStream<any>): Promise<any[]> {
  const reader = stream.getReader()
  const parts: any[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts
}

function basicPrompt(): LanguageModelV3CallOptions['prompt'] {
  return [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
}

test('纯文本流：stream-start 打头，text 增量改名 delta，finish 映射 unified reason 与 usage', async () => {
  const response = sseResponse([
    ': heartbeat\n\n',
    frame('ai-sdk', 'req:1', { type: 'start' }),
    frame('ai-sdk', 'req:2', { type: 'text-start', id: 't1' }),
    frame('ai-sdk', 'req:3', { type: 'text-delta', id: 't1', text: '你好' }),
    frame('ai-sdk', 'req:4', { type: 'text-delta', id: 't1', text: '，世界' }),
    frame('ai-sdk', 'req:5', { type: 'text-end', id: 't1' }),
    frame('ai-sdk', 'req:6', {
      type: 'finish',
      finishReason: 'stop',
      rawFinishReason: 'STOP',
      totalUsage: {
        inputTokens: 12,
        outputTokens: 34,
        inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: 30, reasoningTokens: 4 },
      },
    }),
    frame('end', 'req:7', { request_id: 'req', status: 'complete' }),
  ])
  const captured: CapturedRequest[] = []
  const model = createCompanyLanguageModel({ baseUrl: BASE_URL, apiKey: 'token-1', model: 'm1', fetchImpl: mockFetch(response, captured) })
  const parts = await collect((await model.doStream({ prompt: basicPrompt() })).stream)

  assert.equal(captured[0].url, `${BASE_URL}/stream`)
  assert.equal((captured[0].init.headers as any).Authorization, 'Bearer token-1')
  assert.deepEqual(parts[0], { type: 'stream-start', warnings: [] })
  // 增量按到达顺序逐个透传（合并是 ai 层的职责）
  assert.deepEqual(parts.filter((part) => part.type === 'text-delta'), [
    { type: 'text-delta', id: 't1', delta: '你好' },
    { type: 'text-delta', id: 't1', delta: '，世界' },
  ])
  const finish = parts.find((part) => part.type === 'finish')
  assert.deepEqual(finish, {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'STOP' },
    usage: {
      inputTokens: { total: 12, noCache: 10, cacheRead: 2, cacheWrite: 0 },
      outputTokens: { total: 34, text: 30, reasoning: 4 },
    },
  })
  assert.deepEqual(parts.filter((part) => part.type === 'text-start' || part.type === 'text-end'), [
    { type: 'text-start', id: 't1' },
    { type: 'text-end', id: 't1' },
  ])
  // start（Core）/heartbeat/end 终止帧都不该漏成 provider part
  assert.ok(!parts.some((part) => part.type === 'error'))
})

test('工具调用：tool-call 部件透传，input 字符串化为 provider 形状', async () => {
  const response = sseResponse([
    frame('ai-sdk', 'r:1', { type: 'start' }),
    frame('ai-sdk', 'r:2', { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: { city: '北京' } }),
    frame('ai-sdk', 'r:3', { type: 'finish', finishReason: 'tool-calls', totalUsage: {} }),
    frame('end', 'r:4', { request_id: 'r', status: 'complete' }),
  ])
  const model = createCompanyLanguageModel({ baseUrl: BASE_URL, apiKey: 't', model: 'm', fetchImpl: mockFetch(response) })
  const parts = await collect((await model.doStream({ prompt: basicPrompt() })).stream)
  assert.deepEqual(parts.find((part) => part.type === 'tool-call'), {
    type: 'tool-call',
    toolCallId: 'call_1',
    toolName: 'get_weather',
    input: JSON.stringify({ city: '北京' }),
  })
  assert.equal((parts.find((part) => part.type === 'finish') as any).finishReason.unified, 'tool-calls')

  // doGenerate 聚合：文本 + tool-call 进 content
  const textResponse = sseResponse([
    frame('ai-sdk', 'g:1', { type: 'start' }),
    frame('ai-sdk', 'g:2', { type: 'text-start', id: 'x' }),
    frame('ai-sdk', 'g:3', { type: 'text-delta', id: 'x', text: '查一下' }),
    frame('ai-sdk', 'g:4', { type: 'text-end', id: 'x' }),
    frame('ai-sdk', 'g:5', { type: 'tool-call', toolCallId: 'call_2', toolName: 'get_weather', input: { city: '上海' } }),
    frame('ai-sdk', 'g:6', { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 3, outputTokens: 5 } }),
    frame('end', 'g:7', { request_id: 'g', status: 'complete' }),
  ])
  const generateModel = createCompanyLanguageModel({ baseUrl: BASE_URL, apiKey: 't', model: 'm', fetchImpl: mockFetch(textResponse) })
  const result = await generateModel.doGenerate({ prompt: basicPrompt() })
  assert.deepEqual(result.content, [
    { type: 'text', text: '查一下' },
    { type: 'tool-call', toolCallId: 'call_2', toolName: 'get_weather', input: JSON.stringify({ city: '上海' }) },
  ])
  assert.deepEqual(result.finishReason, { unified: 'tool-calls', raw: undefined })
  assert.deepEqual(result.warnings, [])
})

test('end 帧 failed：产出 error part，绝不静默当成功', async () => {
  const response = sseResponse([
    frame('ai-sdk', 'f:1', { type: 'start' }),
    frame('ai-sdk', 'f:2', { type: 'text-start', id: 't' }),
    frame('ai-sdk', 'f:3', { type: 'text-delta', id: 't', text: '写到一半' }),
    frame('end', 'f:4', { request_id: 'f', status: 'failed', error: { message: 'The model stream stalled.' } }),
  ])
  const model = createCompanyLanguageModel({ baseUrl: BASE_URL, apiKey: 't', model: 'm', fetchImpl: mockFetch(response) })
  const parts = await collect((await model.doStream({ prompt: basicPrompt() })).stream)
  const error = parts.find((part) => part.type === 'error')
  assert.ok(error, 'failed 终止必须产出 error part')
  assert.equal((error as any).error.message, 'The model stream stalled.')
  assert.ok(!parts.some((part) => part.type === 'finish'), 'failed 流不得携带 finish')

  // 终止帧整个缺失（连接半途死）同样以 error 收尾
  const dead = sseResponse([frame('ai-sdk', 'd:1', { type: 'start' })])
  const deadModel = createCompanyLanguageModel({ baseUrl: BASE_URL, apiKey: 't', model: 'm', fetchImpl: mockFetch(dead) })
  const deadParts = await collect((await deadModel.doStream({ prompt: basicPrompt() })).stream)
  assert.equal(deadParts.at(-1)?.type, 'error')
})

test('非 200：抛 APICallError 且错误信息含状态码', async () => {
  const response = sseResponse([JSON.stringify({ error: { code: 'quota_exhausted', message: 'quota exceeded' } })], 429)
  const model = createCompanyLanguageModel({ baseUrl: BASE_URL, apiKey: 't', model: 'm', fetchImpl: mockFetch(response) })
  await assert.rejects(
    model.doStream({ prompt: basicPrompt() }),
    (error: any) => {
      assert.match(error.message, /429/)
      assert.match(error.message, /quota exceeded/)
      assert.equal(error.statusCode, 429)
      assert.equal(error.name, 'AI_APICallError')
      return true
    },
  )
})

test('请求体形状：字段名与 wire schema 逐字对齐，system 上顶层，固定温度/上限覆盖调用方', async () => {
  const response = sseResponse([
    frame('ai-sdk', 'w:1', { type: 'start' }),
    frame('ai-sdk', 'w:2', { type: 'finish', finishReason: 'stop', totalUsage: {} }),
    frame('end', 'w:3', { request_id: 'w', status: 'complete' }),
  ])
  const captured: CapturedRequest[] = []
  const model = createCompanyLanguageModel({
    baseUrl: `${BASE_URL}/`,
    apiKey: 'svc-token',
    model: 'company-model',
    temperature: 0.6,
    maxOutputTokens: 16384,
    fetchImpl: mockFetch(response, captured),
  })
  await model.doStream({
    prompt: [
      { role: 'system', content: '你是编剧。' },
      { role: 'system', content: '输出中文。' },
      { role: 'user', content: [{ type: 'text', text: '写一集' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '先查天气' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'get_weather', input: { city: '北京' } },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'get_weather', output: { type: 'json', value: { temp: 30 } } }],
      },
    ],
    tools: [{
      type: 'function',
      name: 'get_weather',
      description: '查天气',
      inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
    }],
    toolChoice: { type: 'tool', toolName: 'get_weather' },
    temperature: 0.9,
    topP: 0.95,
    maxOutputTokens: 1024,
    stopSequences: ['END'],
    seed: 42,
  })
  assert.equal(captured.length, 1)
  assert.equal(captured[0].url, `${BASE_URL}/stream`)
  const body = JSON.parse(captured[0].init.body as string)
  assert.deepEqual(body, {
    model: 'company-model',
    system: '你是编剧。\n\n输出中文。',
    messages: [
      { role: 'user', content: '写一集' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '先查天气' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'get_weather', input: { city: '北京' } },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'get_weather', output: { type: 'json', value: { temp: 30 } } }],
      },
    ],
    tools: [{ name: 'get_weather', description: '查天气', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } }],
    toolChoice: { tool: 'get_weather' },
    // 固定值覆盖调用方（语义同被删掉的 temperature/max_tokens 补丁）
    temperature: 0.6,
    topP: 0.95,
    maxOutputTokens: 16384,
    stopSequences: ['END'],
    seed: 42,
  })
})
