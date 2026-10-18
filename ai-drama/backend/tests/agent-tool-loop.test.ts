/**
 * 端到端冒烟：ToolLoopAgent（ai@7 原生工具循环）+ 公司后端自定义 provider。
 *
 * mock fetch 返回两轮 SSE：第一轮模型发 tool-call，本地 execute 后结果回喂，
 * 第二轮模型基于工具结果产出文本。锁定：
 * - provider 以 v4 spec 接入 ai 循环
 * - 工具经 wire 协议下发（name/inputSchema），execute 在本地发生
 * - 第二轮请求体携带 assistant tool-call + role:'tool' 结果消息（回喂证据）
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { ToolLoopAgent, tool } from 'ai'
import { createCompanyLanguageModel } from '../src/services/company-llm-model.js'

const BASE_URL = 'https://company.invalid/api/llm'

function frame(event: string, data: unknown): string {
  let out = `event: ${event}\n`
  for (const line of JSON.stringify(data).split('\n')) out += `data: ${line}\n`
  return `${out}\n`
}

function sseResponse(chunks: string[]): Response {
  return new Response(chunks.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  })
}

interface CapturedRequest {
  url: string
  body: any
}

test('ToolLoopAgent + company provider：tool-call → 本地 execute → 回喂 → 产出文本', async () => {
  const captured: CapturedRequest[] = []
  const responses = [
    sseResponse([
      frame('ai-sdk', { type: 'start' }),
      frame('ai-sdk', { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_episode', input: { episode_id: 7 } }),
      frame('ai-sdk', { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 10, outputTokens: 5 } }),
      frame('end', { request_id: 'r1', status: 'complete' }),
    ]),
    sseResponse([
      frame('ai-sdk', { type: 'start' }),
      frame('ai-sdk', { type: 'text-start', id: 't1' }),
      frame('ai-sdk', { type: 'text-delta', id: 't1', text: '已读取第七集' }),
      frame('ai-sdk', { type: 'text-end', id: 't1' }),
      frame('ai-sdk', { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 20, outputTokens: 8 } }),
      frame('end', { request_id: 'r2', status: 'complete' }),
    ]),
  ]
  const fetchImpl: typeof fetch = async (input: any, init?: any) => {
    const body = JSON.parse(init.body)
    captured.push({ url: String(input), body })
    const response = responses[captured.length - 1]
    if (!response) throw new Error(`意外的第 ${captured.length} 次模型调用`)
    return response
  }

  const model = createCompanyLanguageModel({ baseUrl: BASE_URL, apiKey: 'tok', model: 'company-model', fetchImpl })
  assert.equal(model.specificationVersion, 'v4')

  const readEpisode = tool({
    description: '读取剧集内容',
    inputSchema: z.object({ episode_id: z.number() }),
    execute: async ({ episode_id }) => ({ content: `第七集内容(${episode_id})`, episode_id }),
  })

  const agent = new ToolLoopAgent({
    id: 'smoke',
    instructions: '你是测试助手。',
    model,
    tools: { get_episode: readEpisode },
  })
  const result = await agent.generate({ prompt: '请读取第七集' })

  // 两轮模型调用，均打到 /stream
  assert.equal(captured.length, 2)
  assert.ok(captured.every(req => req.url === `${BASE_URL}/stream`))

  // 第一轮：system 顶层 + 工具定义按 wire 形状下发
  assert.equal(captured[0].body.system, '你是测试助手。')
  assert.equal(captured[0].body.tools.length, 1)
  assert.equal(captured[0].body.tools[0].name, 'get_episode')
  assert.equal(captured[0].body.tools[0].description, '读取剧集内容')
  assert.equal(captured[0].body.tools[0].inputSchema.properties.episode_id.type, 'number')
  assert.deepEqual(captured[0].body.messages, [{ role: 'user', content: '请读取第七集' }])

  // 第二轮回喂：assistant tool-call + role:'tool' 的执行结果
  const round2 = captured[1].body
  const assistant = round2.messages.find((m: any) => m.role === 'assistant')
  assert.deepEqual(assistant.content, [
    { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_episode', input: { episode_id: 7 } },
  ])
  const toolMessage = round2.messages.find((m: any) => m.role === 'tool')
  assert.deepEqual(toolMessage.content, [
    { type: 'tool-result', toolCallId: 'call_1', toolName: 'get_episode', output: { type: 'json', value: { content: '第七集内容(7)', episode_id: 7 } } },
  ])

  // 循环结果：文本来自第二轮，工具调用/结果可追溯
  assert.equal(result.text, '已读取第七集')
  assert.equal(result.steps.length, 2)
  assert.equal(result.toolCalls[0]?.toolName, 'get_episode')
  assert.deepEqual(result.toolResults[0]?.output, { content: '第七集内容(7)', episode_id: 7 })
})
