/**
 * hermes gateway 编排客户端契约测试 — mock fetch 锁定：
 * - 非流式一次 POST 取 choices[0].message.content（含请求形状：URL 拼接、Bearer 头、system 首条）
 * - 流式 SSE delta 聚合（data: [DONE] 终止，非 data 行与无增量帧跳过）
 * - 401 错误面（状态码 + 响应体摘录可见）
 * - 超时错误面（AbortSignal.timeout → 可读超时错误）
 * - 未配置 HERMES_AGENT_URL/HERMES_AGENT_KEY 时硬报错（不回落本地编排）
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const BASE_URL = 'https://hermes.invalid'
process.env.HERMES_AGENT_URL = BASE_URL
process.env.HERMES_AGENT_KEY = 'hermes-token'

const { runHermesAgent, streamHermesAgent } = await import('../../src/drama/services/hermes-agent.js')

interface Captured {
  url: string
  headers: Headers
  body: Record<string, unknown>
}

function capture(response: () => Response) {
  const captured: Captured[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    captured.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(init?.body),
    })
    return response()
  }) as typeof fetch
  return {
    captured,
    restore() { globalThis.fetch = original },
  }
}

const chatBody = (extra: Record<string, unknown> = {}) => ({
  instructions: '你是测试编排指令。',
  messages: [{ role: 'user', content: '请处理第七集' }],
  ...extra,
})

/** 未传 correlationId 时 system = 指令 + 自动 uuid 的任务标识行 */
const autoTaggedSystem = /^你是测试编排指令。\n\[task: [0-9a-f-]{36}\]$/u

test('非流式：一次 POST 取 choices[0].message.content，请求形状对齐 gateway 契约', async () => {
  const mock = capture(() => Response.json({
    choices: [{ message: { role: 'assistant', content: '已保存分镜' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }))
  try {
    const result = await runHermesAgent(chatBody())
    assert.equal(result.text, '已保存分镜')
    assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })

    assert.equal(mock.captured.length, 1)
    const [request] = mock.captured
    assert.equal(request.url, `${BASE_URL}/v1/chat/completions`)
    assert.equal(request.headers.get('authorization'), 'Bearer hermes-token')
    // system 指令首条（尾部自动拼 [task: uuid] 任务标识）+ 用户消息随行；非流式不带 stream 字段
    assert.equal(request.body.messages.length, 2)
    assert.match(request.body.messages[0]!.content, autoTaggedSystem)
    assert.deepEqual(request.body.messages.slice(1), [
      { role: 'user', content: '请处理第七集' },
    ])
    assert.equal('stream' in request.body, false)
  } finally { mock.restore() }
})

test('流式：SSE 文本增量按序聚合，data: [DONE] 终止', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"role":"assistant"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"你好，"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"世界"}}]}',
    '',
    ': heartbeat',
    '',
    'data: {"choices":[{"delta":{}}]}',
    '',
    'data: [DONE]',
    '',
    'data: {"choices":[{"delta":{"content":"终止后不应出现"}}]}',
    '',
  ].join('\n')
  const mock = capture(() => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
  try {
    let text = ''
    for await (const delta of await runHermesAgent({ ...chatBody(), stream: true })) text += delta
    assert.equal(text, '你好，世界')

    const [request] = mock.captured
    assert.equal(request.body.stream, true)
    assert.equal(request.body.messages.length, 2)
    assert.match(request.body.messages[0]!.content, autoTaggedSystem)
    assert.deepEqual(request.body.messages.slice(1), [
      { role: 'user', content: '请处理第七集' },
    ])
    // streamHermesAgent 与 runHermesAgent({stream:true}) 同一形状
    let again = ''
    for await (const delta of await streamHermesAgent(chatBody())) again += delta
    assert.equal(again, '你好，世界')
  } finally { mock.restore() }
})

test('401：非流式与流式都抛出携带状态码与响应体摘录的错误', async () => {
  const mock = capture(() => new Response('{"error":"invalid key"}', { status: 401 }))
  try {
    await assert.rejects(runHermesAgent(chatBody()), /HTTP 401.*invalid key/)
    await assert.rejects(runHermesAgent({ ...chatBody(), stream: true }), /HTTP 401/)
  } finally { mock.restore() }
})

test('超时：AbortSignal.timeout 触发时翻译为可读超时错误', async () => {
  const original = globalThis.fetch
  globalThis.fetch = ((_input: any, init?: any) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')))
    })) as typeof fetch
  try {
    await assert.rejects(
      runHermesAgent({ ...chatBody(), timeoutMs: 20 }),
      /hermes gateway 请求超时（0s）/u,
    )
  } finally { globalThis.fetch = original }
})

test('未配置 env：硬报错指向 HERMES_AGENT_URL/HERMES_AGENT_KEY，不发请求', async () => {
  const { HERMES_AGENT_URL: savedUrl, HERMES_AGENT_KEY: savedKey } = process.env
  delete process.env.HERMES_AGENT_URL
  delete process.env.HERMES_AGENT_KEY
  let called = false
  const original = globalThis.fetch
  globalThis.fetch = (async () => { called = true; return new Response() }) as typeof fetch
  try {
    await assert.rejects(
      runHermesAgent(chatBody()),
      /编排已外移到 hermes gateway，需配置 HERMES_AGENT_URL\/HERMES_AGENT_KEY/,
    )
    await assert.rejects(streamHermesAgent(chatBody()), /HERMES_AGENT_URL/)
    assert.equal(called, false)
  } finally {
    globalThis.fetch = original
    process.env.HERMES_AGENT_URL = savedUrl
    process.env.HERMES_AGENT_KEY = savedKey
  }
})

test('关联 id：correlationId 作为 X-Correlation-Id 头发出，缺省生成 uuid（非流式与流式）', async () => {
  const sse = () => new Response(
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
  // 依次应答：非流式 JSON → 流式 SSE → 非流式 JSON（uuid 兜底）
  const responses = [() => Response.json({ choices: [{ message: { content: '完成' } }] }), sse, () => Response.json({ choices: [{ message: { content: '完成' } }] })]
  const captured: Captured[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    captured.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(init?.body) })
    return responses[captured.length - 1]!()
  }) as typeof fetch
  try {
    await runHermesAgent({ ...chatBody(), correlationId: 'film-run-42' })
    // 流式路径同样带头（capture 记录每个出站请求的头）
    for await (const _delta of await streamHermesAgent({ ...chatBody(), correlationId: 'film-run-42' })) break
    await runHermesAgent(chatBody()) // 未传：自动 uuid

    assert.equal(captured.length, 3)
    const [withId, streamed, fallback] = captured
    assert.equal(withId.headers.get('x-correlation-id'), 'film-run-42')
    assert.equal(streamed.headers.get('x-correlation-id'), 'film-run-42')
    assert.match(fallback.headers.get('x-correlation-id')!, /^[0-9a-f-]{36}$/u)
  } finally { globalThis.fetch = original }
})

test('会话隔离：system 尾部拼 [task: <correlationId>] 标识行，缺省时用同一 uuid（非流式与流式）', async () => {
  const sse = () => new Response(
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
  // 依次应答：film-run-42 → 流式 film-run-43 → uuid 兜底（非流式）→ uuid 兜底（流式）→ 同任务两轮
  const responses = [
    () => Response.json({ choices: [{ message: { content: '完成' } }] }),
    sse,
    () => Response.json({ choices: [{ message: { content: '完成' } }] }),
    sse,
    () => Response.json({ choices: [{ message: { content: '完成' } }] }),
    () => Response.json({ choices: [{ message: { content: '完成' } }] }),
  ]
  const captured: Captured[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    captured.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(init?.body) })
    return responses[captured.length - 1]!()
  }) as typeof fetch
  try {
    // 同指令不同任务：只有任务标识不同 → system 必然不同 → gateway 会话必然隔离
    await runHermesAgent({ ...chatBody(), correlationId: 'film-run-42' })
    for await (const _delta of await streamHermesAgent({ ...chatBody(), correlationId: 'film-run-43' })) break
    await runHermesAgent(chatBody())
    for await (const _delta of await streamHermesAgent(chatBody())) break

    assert.equal(captured.length, 4)
    const system = (i: number) => (captured[i]!.body.messages as { role: string; content: string }[])[0]!.content
    assert.match(system(0), /\n\[task: film-run-42\]$/u)
    assert.match(system(1), /\n\[task: film-run-43\]$/u)
    // 缺省时任务标识 = 同一请求的 X-Correlation-Id（uuid），标识与关联头一致
    for (const i of [2, 3]) {
      const correlation = captured[i]!.headers.get('x-correlation-id')!
      assert.match(correlation, /^[0-9a-f-]{36}$/u)
      assert.match(system(i), new RegExp(`\\n\\[task: ${correlation}\\]$`, 'u'))
    }
    // 同任务多轮（同 correlationId）system 完全一致 → 仍归同一会话，连续性保留
    await runHermesAgent({ ...chatBody(), correlationId: 'creative-project-7' })
    await runHermesAgent({ ...chatBody(), correlationId: 'creative-project-7' })
    assert.equal(system(4), system(5))
  } finally { globalThis.fetch = original }
})

test('agents 注册表薄封装：instructions 装配为 system 消息经 gateway 执行，结果保持旧形状', async () => {
  // agents/context.ts → app-settings → db：导入前指向临时库，避免写用户数据
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-agent-registry-'))
  process.env.SQLITE_PATH = path.join(dir, 'test.sqlite')
  process.env.MYSQL_AUTO_IMPORT = 'false'
  const { getAgent } = await import('../../src/drama/agents/index.js')
  try {
    assert.equal(getAgent('no_such_agent', { episodeId: 1, dramaId: 1 }), undefined)

    const mock = capture(() => Response.json({ choices: [{ message: { content: '完成' } }] }))
    try {
      const agent = await getAgent('extractor', { episodeId: 7, dramaId: 3, language: 'ja' })
      const result = await agent!.generate({ messages: [{ role: 'user', content: '提取角色' }] })
      // 旧 AgentRunResult 形状：工具循环在 hermes 侧，轨迹字段恒为空数组
      assert.deepEqual(result, { text: '完成', toolCalls: [], toolResults: [], steps: [] })

      const [request] = mock.captured
      assert.equal(request.url, `${BASE_URL}/v1/chat/completions`)
      const [system, user] = request.body.messages as { role: string; content: string }[]
      assert.equal(system.role, 'system')
      // instructions 装配链落进 system：prompt/技能文本 + 目标语言指令块（ja 触发）
      assert.ok(system.content.length > 100)
      assert.match(system.content, /## Output Language \(HIGHEST PRIORITY\)/)
      assert.match(system.content, /日本語/)
      // 注册表上下文 id（episode 优先）落进任务标识行 → 同集同 agent 复用会话
      assert.match(system.content, /\n\[task: episode-7\]$/u)
      assert.deepEqual(user, { role: 'user', content: '提取角色' })
    } finally { mock.restore() }
  } finally {
    delete process.env.SQLITE_PATH
    await fs.rm(dir, { recursive: true, force: true })
  }
})
