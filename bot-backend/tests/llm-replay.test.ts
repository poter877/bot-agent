import { describe, expect, it } from 'vitest'
import { generateText, jsonSchema, streamText, tool, type LanguageModel, type ModelMessage } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogle } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { llmStreamRequestSchema } from '../src/modules/llm/request.js'

const tools = { computer: tool({ inputSchema: jsonSchema({ type: 'object', properties: { action: { type: 'string' } }, required: ['action'] }) }) }
const user: ModelMessage = { role: 'user', content: 'Read the screen' }
const result: ModelMessage = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'computer', output: { type: 'text', value: 'Screen captured' } }] }

/** Use the pinned SDK twice, verifying the *native HTTP body*, not a mirrored field assertion. */
async function twoRounds(model: LanguageModel, stream: boolean, providerOptions?: Parameters<typeof generateText>[0]['providerOptions']) {
  const options = { model, messages: [user], tools, providerOptions, maxOutputTokens: 2000, maxRetries: 0 }
  const first = stream ? streamText(options) : await generateText(options)
  // A serialized SDK result has providerMetadata; the canonical Python mapper
  // sends providerOptions. Both versions cross the same validated boundary.
  const content = JSON.parse(JSON.stringify((await first.content).filter((part) => ['text', 'reasoning', 'tool-call'].includes(part.type))))
  const request = llmStreamRequestSchema.parse({ model: 'company-model', messages: [user, { role: 'assistant', content }, result] })
  await generateText({ model, messages: request.messages as ModelMessage[], tools, providerOptions, maxOutputTokens: 2000, maxRetries: 0 })
}

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}

function anthropicStream() {
  return sse([
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Check the screen.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-thought' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'opaque-thought' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Looking.' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'call_1', name: 'computer', input: {} } },
    { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"action":"screenshot"}' } },
    { type: 'content_block_stop', index: 3 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ])
}

function openaiStream(response: { output: Array<Record<string, unknown>> }) {
  const [reasoning, text, call] = response.output
  return sse([
    { type: 'response.created', response: { ...response, output: [], status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, encrypted_content: null, summary: [] } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'Check the screen.' },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.added', output_index: 1, item: { ...text, content: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'Looking.' },
    { type: 'response.output_item.done', output_index: 1, item: text },
    { type: 'response.output_item.added', output_index: 2, item: { ...call, arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 2, delta: '{"action":"screenshot"}' },
    { type: 'response.output_item.done', output_index: 2, item: call },
    { type: 'response.completed', response },
  ])
}

describe('provider state replay through the validated model request', () => {
  it.each([false, true])('replays Anthropic signed and redacted thinking with stream=%s', async (stream) => {
    const requests: unknown[] = []
    const anthropic = createAnthropic({ apiKey: 'test', fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      if (JSON.parse(String(init?.body)).stream) return anthropicStream()
      return Response.json({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', content: [
        { type: 'thinking', thinking: 'Check the screen.', signature: 'signed-thought' },
        { type: 'redacted_thinking', data: 'opaque-thought' },
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', id: 'call_1', name: 'computer', input: { action: 'screenshot' } },
      ], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
    } })
    await twoRounds(anthropic('claude-test'), stream)
    expect(requests[1]).toMatchObject({ messages: [
      { role: 'user' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'Check the screen.', signature: 'signed-thought' },
        { type: 'redacted_thinking', data: 'opaque-thought' },
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', id: 'call_1', name: 'computer', input: { action: 'screenshot' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1' }] },
    ] })
  })

  it.each([false, true])('replays Google signatures without a skip sentinel with stream=%s', async (stream) => {
    const requests: unknown[] = []
    const google = createGoogle({ apiKey: 'test', fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      const response = { candidates: [{ content: { role: 'model', parts: [
        { text: 'Check the screen.', thought: true, thoughtSignature: 'reasoning-signature' },
        { text: 'Looking.', thoughtSignature: 'text-signature' },
        { functionCall: { id: 'call_1', name: 'computer', args: { action: 'screenshot' } }, thoughtSignature: 'tool-signature' },
      ] }, finishReason: 'STOP' }] }
      return String(_url).includes('streamGenerateContent') ? sse([response]) : Response.json(response)
    } })
    await twoRounds(google('gemini-3-flash-preview'), stream)
    expect(requests[1]).toMatchObject({ contents: [
      { role: 'user' },
      { role: 'model', parts: [
        { text: 'Check the screen.', thought: true, thoughtSignature: 'reasoning-signature' },
        { text: 'Looking.', thoughtSignature: 'text-signature' },
        { functionCall: { id: 'call_1', name: 'computer', args: { action: 'screenshot' } }, thoughtSignature: 'tool-signature' },
      ] },
      { role: 'user', parts: [{ functionResponse: { id: 'call_1', name: 'computer' } }] },
    ] })
  })

  it.each([{ store: true, stream: false }, { store: false, stream: false }, { store: true, stream: true }, { store: false, stream: true }])('replays OpenAI state with $store and stream=$stream', async ({ store, stream }) => {
    const requests: Array<{ input: unknown[] }> = []
    const openai = createOpenAI({ apiKey: 'test', fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      const response = { id: 'resp_1', object: 'response', created_at: 0, model: 'gpt-5', status: 'completed', output: [
        { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Check the screen.' }], encrypted_content: 'encrypted-thought' },
        { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text: 'Looking.', annotations: [] }] },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'computer', arguments: '{"action":"screenshot"}', status: 'completed' },
      ], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
      return JSON.parse(String(init?.body)).stream ? openaiStream(response) : Response.json(response)
    } })
    await twoRounds(openai('gpt-5'), stream, { openai: { store } })
    expect(requests[1]?.input).toContainEqual(store
      ? { type: 'item_reference', id: 'rs_1' }
      : { type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted-thought', summary: [{ type: 'summary_text', text: 'Check the screen.' }] })
    expect(requests[1]?.input).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }))
    expect(requests[1]?.input).toContainEqual(expect.objectContaining({ type: 'function_call', call_id: 'call_1', name: 'computer' }))
    if (store) {
      expect(requests[1]?.input).toContainEqual({ type: 'item_reference', id: 'msg_1' })
    } else {
      expect(requests[1]?.input).toContainEqual(expect.objectContaining({ role: 'assistant', content: 'Looking.', phase: 'commentary' }))
    }
  })
})
