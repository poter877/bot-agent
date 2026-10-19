import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { generateText, type ModelMessage } from 'ai'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import { createGoogle } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { llmStreamRequestSchema } from '../src/modules/llm/request.js'
import { directMediaOnly, validateMedia } from '../src/modules/llm/media.js'
import { createModelResolver } from '../src/modules/llm/providers.js'
import { parseModelCatalog } from '../src/modules/llm/catalog.js'
import { createTestApp, flushRateLimits, registerUser, truncateAll, uniqueEmail, type TestApp } from './helpers.js'

const IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE9sAAAAASUVORK5CYII='
const VIDEO = Buffer.from('video fixture').toString('base64')
const file = (mediaType: string, data: string) => ({
  type: 'file', mediaType, data: { type: 'data', data },
})

describe('model input preserves multimodal content', () => {
  it('accepts mixed text, image and video in user messages without flattening', () => {
    const content = [{ type: 'text', text: 'Compare this picture and video.' }, file('image/png', IMAGE), file('video/mp4', VIDEO)]
    const parsed = llmStreamRequestSchema.parse({ model: 'media', messages: [{ role: 'user', content }] })
    expect(parsed.messages[0]?.content).toEqual(content)
  })

  it('preserves screenshots attached to tool results', () => {
    const output = { type: 'content', value: [{ type: 'text', text: 'Screenshot captured.' }, file('image/png', IMAGE)] }
    const content = [{ type: 'tool-result', toolCallId: 'capture-1', toolName: 'computer', output }]
    const parsed = llmStreamRequestSchema.parse({ model: 'media', messages: [{ role: 'tool', content }] })
    expect(parsed.messages[0]?.content).toEqual(content)
  })

  it('validates media encoding, public URLs and unknown part fields', () => {
    for (const content of [
      [file('image/png', 'not base64!')],
      [{ type: 'file', mediaType: 'image/png', data: { type: 'url', url: 'not-url' } }],
      [{ type: 'file', mediaType: 'image/png', data: { type: 'url', url: 'https://127.0.0.1/private' } }],
      [{ type: 'file', mediaType: 'image/png', data: { type: 'url', url: 'file:///etc/passwd' } }],
      [{ ...file('image/png', IMAGE), silentlyIgnored: true }],
    ]) {
      expect(llmStreamRequestSchema.safeParse({ model: 'media', messages: [{ role: 'user', content }] }).success).toBe(false)
    }
  })
})

describe('authenticated media request through real AI SDK Core', () => {
  let testApp: TestApp
  const calls: LanguageModelV4CallOptions[] = []
  const model = new MockLanguageModelV4({
    supportedUrls: { '*': [/^https?:\/\//] },
    doStream: async (options) => {
      calls.push(options)
      return { stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: 'Observed.' },
        { type: 'text-end', id: 'text-1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: {
          inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        } },
      ]) }
    },
  })
  beforeAll(async () => {
    testApp = await createTestApp({ GOOGLE_GENERATIVE_AI_API_KEY: 'test-key', OPENAI_API_KEY: 'test-key' }, {
      catalog: parseModelCatalog(JSON.stringify([
        { id: 'video', provider: 'google', model: 'gemini-2.5-flash' },
        { id: 'images', provider: 'openai', model: 'gpt-test' },
      ])), modelResolver: () => model,
    })
  })
  beforeEach(async () => {
    await truncateAll(testApp.database)
    await flushRateLimits(testApp.redis)
    calls.length = 0
  })
  afterAll(async () => { await testApp.close() })

  async function send(modelId: string, messages: unknown[]) {
    const user = await registerUser(testApp.app, testApp.database, uniqueEmail(), 'password-123456')
    return testApp.app.request('/api/llm/stream', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3100', cookie: user.cookie },
      body: JSON.stringify({ model: modelId, messages }),
    })
  }

  it('delivers user image/video bytes, assistant files and tool screenshots to the model', async () => {
    const response = await send('video', [
      { role: 'user', content: [{ type: 'text', text: 'Compare.' }, file('image/png', IMAGE), file('video/mp4', VIDEO)] },
      { role: 'assistant', content: [file('image/png', IMAGE), { type: 'tool-call', toolCallId: 'c1', toolName: 'computer', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'computer', output: { type: 'content', value: [file('image/png', IMAGE)] } }] },
    ])
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"status":"complete"')
    expect(calls).toHaveLength(1)
    const prompt = calls[0]!.prompt
    expect(prompt[0]).toMatchObject({ role: 'user', content: [
      { type: 'text', text: 'Compare.' },
      { type: 'file', mediaType: 'image/png', data: { type: 'data', data: IMAGE } },
      { type: 'file', mediaType: 'video/mp4', data: { type: 'data', data: VIDEO } },
    ] })
    expect(prompt[1]).toMatchObject({ role: 'assistant', content: [{ type: 'file', mediaType: 'image/png' }, { type: 'tool-call' }] })
    expect(prompt[2]).toMatchObject({ role: 'tool', content: [{ output: { type: 'content', value: [{ type: 'file', mediaType: 'image/png' }] } }] })
  })

  it.each(['http', 'https'])('revives direct %s media URLs without downloading them on the backend', async (scheme) => {
    const url = `${scheme}://media.example.com/picture.png`
    const response = await send('images', [{ role: 'user', content: [
      { type: 'file', mediaType: 'image/png', data: { type: 'url', url }, providerOptions: { openai: { imageDetail: 'high' } } },
    ] }])
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"status":"complete"')
    expect(calls[0]!.prompt[0]).toMatchObject({ content: [{ data: { type: 'url', url: new URL(url) }, providerOptions: { openai: { imageDetail: 'high' } } }] })
    await expect(directMediaOnly([{ url: new URL('https://media.example.com/file'), isUrlSupportedByModel: false }])).rejects.toThrow('backend downloads are disabled')
  })

  it('returns a clear model capability error before creating a stream or losing video', async () => {
    const response = await send('images', [{ role: 'user', content: [file('video/mp4', VIDEO)] }])
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'unsupported_media' } })
    expect(calls).toHaveLength(0)
  })

  it('accepts media above the former text-sized body cap', async () => {
    const video = Buffer.alloc(4 * 1024 * 1024).toString('base64')
    const response = await send('video', [{ role: 'user', content: [file('video/mp4', video)] }])
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"status":"complete"')
    expect(calls[0]!.prompt[0]).toMatchObject({ content: [{ data: { data: video } }] })
  })
})

describe('pinned provider adapters receive actual media payloads', () => {
  it('encodes native video and tool screenshot bytes with the Google adapter', async () => {
    const requests: unknown[] = []
    const google = createGoogle({ apiKey: 'test', fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: 'Observed.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } })
    } })
    const request = llmStreamRequestSchema.parse({ model: 'video', messages: [
      { role: 'user', content: [file('video/mp4', VIDEO)] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'computer', input: {}, providerOptions: { google: { thoughtSignature: 'signed-state' } } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'computer', output: { type: 'content', value: [file('image/png', IMAGE)] } }] },
    ] })
    const model = google('gemini-3-flash-preview')
    await validateMedia(request, 'google', model)
    const result = await generateText({ model, messages: request.messages as ModelMessage[], maxRetries: 0, experimental_download: directMediaOnly })
    expect(result.text).toBe('Observed.')
    expect(requests[0]).toMatchObject({ contents: [
      { role: 'user', parts: [{ inlineData: { mimeType: 'video/mp4', data: VIDEO } }] },
      { role: 'model', parts: [{ functionCall: { name: 'computer', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'computer', parts: [{ inlineData: { mimeType: 'image/png', data: IMAGE } }] } }] },
    ] })
    expect(createModelResolver(() => 'test')({ id: 'v', provider: 'google', model: 'gemini-2.5-flash', enabled: true })).toMatchObject({ provider: 'google.generative-ai' })
  })

  it('passes a native Google video URL directly without a backend media fetch', async () => {
    const requests: Array<{ url: string; body: unknown }> = []
    const google = createGoogle({ apiKey: 'test', fetch: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: 'Observed.' }] }, finishReason: 'STOP' }] })
    } })
    const request = llmStreamRequestSchema.parse({ model: 'video', messages: [{ role: 'user', content: [
      { type: 'file', mediaType: 'video/mp4', data: { type: 'url', url: 'https://media.example.com/clip.mp4' } },
    ] }] })
    const model = google('gemini-2.5-flash')
    await validateMedia(request, 'google', model)
    expect((await generateText({ model, messages: request.messages as ModelMessage[], maxRetries: 0, experimental_download: directMediaOnly })).text).toBe('Observed.')
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toContain('generativelanguage.googleapis.com')
    expect(requests[0]!.body).toMatchObject({ contents: [{ role: 'user', parts: [{ fileData: { mimeType: 'video/mp4', fileUri: 'https://media.example.com/clip.mp4' } }] }] })
  })

  it('rejects adapter combinations that would discard files or turn them into text', async () => {
    const assistant = llmStreamRequestSchema.parse({ model: 'media', messages: [{ role: 'assistant', content: [file('image/png', IMAGE)] }] })
    await expect(validateMedia(assistant, 'openai', createOpenAI({ apiKey: 'test' })('gpt-test'))).rejects.toMatchObject({ code: 'unsupported_media' })
    const toolUrl = llmStreamRequestSchema.parse({ model: 'media', messages: [{ role: 'tool', content: [{
      type: 'tool-result', toolCallId: 'c1', toolName: 'computer', output: { type: 'content', value: [{
        type: 'file', mediaType: 'image/png', data: { type: 'url', url: 'https://media.example.com/screenshot.png' },
      }] },
    }] }] })
    await expect(validateMedia(toolUrl, 'google', createGoogle({ apiKey: 'test' })('gemini-2.5-flash'))).rejects.toMatchObject({ code: 'media_inline_required' })
  })

  it('retains image bytes and imageDetail through the OpenAI Responses adapter', async () => {
    let body: unknown
    const openai = createOpenAI({ apiKey: 'test', fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json({ id: 'resp_1', object: 'response', created_at: 0, model: 'gpt-test', status: 'completed', output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Observed.', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } })
    } })
    const request = llmStreamRequestSchema.parse({ model: 'images', messages: [{ role: 'user', content: [{ ...file('image/png', IMAGE), providerOptions: { openai: { imageDetail: 'high' } } }] }] })
    const result = await generateText({ model: openai('gpt-test'), messages: request.messages as ModelMessage[], maxRetries: 0, experimental_download: directMediaOnly })
    expect(result.text).toBe('Observed.')
    expect(body).toMatchObject({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${IMAGE}`, detail: 'high' }] }] })
  })

  it('retains screenshot bytes through the Anthropic adapter', async () => {
    let body: unknown
    const anthropic = createAnthropic({ apiKey: 'test', fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'Observed.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
    } })
    const request = llmStreamRequestSchema.parse({ model: 'images', messages: [{ role: 'user', content: [file('image/png', IMAGE)] }] })
    const result = await generateText({ model: anthropic('claude-test'), messages: request.messages as ModelMessage[], maxOutputTokens: 100, maxRetries: 0, experimental_download: directMediaOnly })
    expect(result.text).toBe('Observed.')
    expect(body).toMatchObject({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMAGE } }] }] })
  })
})
