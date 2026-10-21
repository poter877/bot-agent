/**
 * MCP 服务端契约测试：
 * - 工具清单：领域工具全集 + 生成任务工具 + film build 工具，episodeId/dramaId 并入可选入参
 * - InMemoryTransport 端到端：list tools / 真实工具调用（temp SQLite 落库）
 * - 上下文注入：带 episodeId 走通、缺省走既有守卫返回 error 结果
 * - submit_image_task → get_task_status 链路（生成配置指向不可达地址，任务落库即可）
 * - film build 工具：write_file 工程沙箱（越界拒绝、缺 projectId 守卫、agent.log 日志行）、
 *   render_frame 返回 ImageContent（base64 JPEG + mime）、run_blender 走 BLENDER_PATH 探测执行
 * - /mcp 路由 Bearer 鉴权：缺令牌 / 错令牌 / 未配置 env 一律 403 fail-closed
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-server-'))
import { Pool } from 'pg'
const __base = process.env.DATABASE_URL
if (!__base) throw new Error('tests need DATABASE_URL (point at the test cluster, e.g. bot_backend_test)')
const __admin = new Pool({ connectionString: __base })
const __dbName = 'drama_' + process.pid + '_' + (Date.now() % 1000000)
await __admin.query(`CREATE DATABASE "${__dbName}" TEMPLATE bot_backend_test`)
process.env.DATABASE_URL = __base.replace(/\/[^/?]+$/, `/${__dbName}`)
process.env.STORAGE_PATH = path.join(dir, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.AI_DRAMA_MCP_TOKEN = 'test-token'

const { db, schema, getInsertId } = await import('../../src/drama/db/index.js')
const { buildMcpServer } = await import('../../src/drama/mcp/server.js')
const { pipelineRunner, getPipelineState } = await import('../../src/drama/services/creative-pipeline/runner.js')
// 无 auth 注入：测试只覆盖静态令牌面；用户会话面（createMcpApp(auth)）
// 在鉴权统一后由集成测试覆盖。
const mcpRoute = (await import('../../src/drama/mcp/route.js')).createMcpApp(null)
const { STORAGE_ROOT } = await import('../../src/drama/utils/paths.js')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

const now = new Date().toISOString()
let episodeId = 0
let pipelineRunId = 0
/** film build 工具的目标工程（filmProjectDir 只拼路径，不需要库里有行） */
const FILM_PROJECT_ID = 901
const filmDir = path.join(STORAGE_ROOT, 'films', String(FILM_PROJECT_ID))
const agentLogText = () => fs.readFileSync(path.join(filmDir, 'agent.log'), 'utf8')

/** 冒充可执行文件的桩脚本（0o755） */
function stubScript(dir: string, name: string, lines: string[]): string {
  const exe = path.join(dir, name)
  fs.writeFileSync(exe, ['#!/bin/sh', ...lines].join('\n'), { mode: 0o755 })
  return exe
}

async function connectClient() {
  const server = buildMcpServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, server }
}

function parseTextContent(result: { content: Array<{ type: string; text: string }> }) {
  assert.equal(result.content.length, 1, 'tool result carries exactly one content part')
  assert.equal(result.content[0].type, 'text')
  return JSON.parse(result.content[0].text)
}

test('seed: drama + episode with script content', async () => {
  const dramaId = getInsertId(await db.insert(schema.dramas).values({
    title: 'MCP 测试剧', createdAt: now, updatedAt: now,
  }).returning().returning().returning().returning().returning().returning().returning().returning().returning({ id: schema.dramas.id }))
  episodeId = getInsertId(await db.insert(schema.episodes).values({
    dramaId, episodeNumber: 1, title: '第一集', content: '原始小说内容，待改写为剧本',
    scriptContent: '## S1 | 内景 · 客厅 | 夜\n林小雨说：「你来了。」',
    createdAt: now, updatedAt: now,
  }).returning().returning().returning().returning().returning().returning().returning().returning().returning({ id: schema.episodes.id }))
  // 生成配置指向不可达地址：submit 测试只验证任务落库，后台处理快速失败即可
  await db.insert(schema.aiServiceConfigs).values({
    serviceType: 'image', provider: 'company', name: 'image-config',
    baseUrl: 'https://company.invalid', apiKey: 'secret', model: JSON.stringify(['company-image-model']),
    isActive: true, createdAt: now, updatedAt: now,
  }).returning().returning().returning().returning().returning().returning().returning().returning()
})

test('list tools: 领域工具全集 + 任务工具 + build 工具，上下文字段并入可选入参', async () => {
  const { client } = await connectClient()
  const { tools } = await client.listTools()
  const names = tools.map(t => t.name)

  // script(3) + creative(2) + extract(7) + storyboard(3) + image-prompt(6) + 任务工具(3) + build 工具(4) + 管线(1)
  const expected = [
    'read_episode_script', 'rewrite_to_screenplay', 'save_script',
    'read_creative_project', 'save_creative_plan',
    'read_script_for_extraction', 'read_existing_characters', 'read_existing_scenes',
    'read_existing_props', 'save_dedup_characters', 'save_dedup_scenes', 'save_dedup_props',
    'read_storyboard_context', 'save_storyboards', 'update_storyboard',
    'read_characters', 'save_character_final_prompt', 'read_scenes', 'save_scene_final_prompt',
    'read_props', 'save_prop_final_prompt',
    'submit_image_task', 'submit_video_task', 'get_task_status',
    'write_file', 'render_frame', 'run_blender', 'generate_texture',
    'pipeline_start',
  ]
  assert.deepEqual([...names].sort(), [...expected].sort())
  assert.equal(names.length, new Set(names).size, 'tool names unique')

  const readScript = tools.find(t => t.name === 'read_episode_script')!
  assert.ok(readScript.inputSchema.properties.episodeId, 'episodeId merged into input schema')
  assert.ok(readScript.inputSchema.properties.dramaId, 'dramaId merged into input schema')
  const required: string[] = readScript.inputSchema.required ?? []
  assert.ok(!required.includes('episodeId') && !required.includes('dramaId'), 'context fields optional')

  // 原工具入参保留（save_script 的 content 必填）
  const saveScript = tools.find(t => t.name === 'save_script')!
  assert.ok(saveScript.inputSchema.properties.content)
  assert.ok((saveScript.inputSchema.required ?? []).includes('content'))

  // build 工具无上下文注入链：projectId 必填（缺省即守卫）
  const writeFile = tools.find(t => t.name === 'write_file')!
  assert.ok((writeFile.inputSchema.required ?? []).includes('projectId'))
})

test('call tool with episodeId: read_episode_script 走真实 DB 返回剧本', async () => {
  const { client } = await connectClient()
  const result = await client.callTool({ name: 'read_episode_script', arguments: { episodeId } })
  const payload = (await parseTextContent(result))
  assert.equal(payload.episode_id, episodeId)
  // read_episode_script 优先返回 content（原始内容），scriptContent 为改写产物
  assert.ok(payload.content.includes('原始小说内容'))
})

test('call tool without context: 既有守卫返回 error 结果（不抛异常）', async () => {
  const { client } = await connectClient()
  const result = await client.callTool({ name: 'read_episode_script', arguments: {} })
  const payload = (await parseTextContent(result))
  assert.equal(payload.error, 'Missing episodeId in request context')
})

test('submit_image_task → get_task_status：任务落 sys_task 且可轮询', async () => {
  const { client } = await connectClient()
  const submit = await client.callTool({
    name: 'submit_image_task',
    arguments: { prompt: '一只赛博朋克猫', episodeId, drama_id: 1, size: '1024x1024' },
  })
  const { task_id } = (await parseTextContent(submit))
  assert.equal(typeof task_id, 'number')

  const status = await client.callTool({ name: 'get_task_status', arguments: { task_id } })
  const row = (await parseTextContent(status))
  assert.equal(row.id, task_id)
  assert.equal(row.type, 'image')
  assert.equal(row.prompt, '一只赛博朋克猫')
  assert.ok(['processing', 'completed', 'failed'].includes(row.status))
})

test('get_task_status 对不存在任务返回 error 结果', async () => {
  const { client } = await connectClient()
  const result = await client.callTool({ name: 'get_task_status', arguments: { task_id: -1 } })
  assert.ok(String((await parseTextContent(result)).error).includes('not found'))
})

// ─── film build 工具（write_file / render_frame / run_blender）────────────────

test('write_file: 写入工程目录并追加 agent.log 日志行', async () => {
  const { client } = await connectClient()
  const result = await client.callTool({
    name: 'write_file',
    arguments: { projectId: FILM_PROJECT_ID, path: 'index.html', content: '<html>DUR</html>' },
  })
  assert.deepEqual((await parseTextContent(result)), { ok: true, path: 'index.html' })
  assert.equal(fs.readFileSync(path.join(filmDir, 'index.html'), 'utf8'), '<html>DUR</html>')
  assert.match(agentLogText(), / write_file index\.html \(16 chars\)/)
})

test('write_file: 路径越界拒绝（../ 与绝对路径都不落盘）', async () => {
  const { client } = await connectClient()
  const escape = await client.callTool({
    name: 'write_file',
    arguments: { projectId: FILM_PROJECT_ID, path: '../escape.txt', content: 'x' },
  })
  assert.match(String((await parseTextContent(escape)).error), /路径越界/)
  const absolute = await client.callTool({
    name: 'write_file',
    arguments: { projectId: FILM_PROJECT_ID, path: '/tmp/escape.txt', content: 'x' },
  })
  assert.match(String((await parseTextContent(absolute)).error), /路径越界/)
  assert.ok(!fs.existsSync(path.join(STORAGE_ROOT, 'films', 'escape.txt')))
})

test('write_file: 缺 projectId 被拒绝（schema 校验 error 结果，不落盘）', async () => {
  const { client } = await connectClient()
  const result = await client.callTool({ name: 'write_file', arguments: { path: 'x.txt', content: 'x' } })
  const text = (result.content as { type: string; text?: string }[])[0]!.text!
  assert.match(text, /projectId/i)
  assert.ok(!fs.existsSync(path.join(STORAGE_ROOT, 'films', 'undefined')))
})

test('render_frame: 返回 ImageContent（base64 JPEG + mime），日志链完整', async () => {
  // PATH 前置一个 node 桩冒充 still.mjs 执行器：按 --out/--prefix 落一个假 JPEG
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-node-'))
  stubScript(binDir, 'node', [
    '# 测试桩：$1=still.mjs $2=工程目录 $3=t；把收到的参数与假图写进 --out 目录',
    'out=""; prefix=""',
    'prev=""',
    'for a in "$@"; do',
    '  case "$prev" in --out) out="$a";; --prefix) prefix="$a";; esac',
    '  prev="$a"',
    'done',
    'mkdir -p "$out"',
    'printf "fake-jpeg" > "$out/${prefix}$3.jpg"',
    'printf "%s" "$*" > "$out/stub-args.txt"',
  ])
  const savedPath = process.env.PATH
  process.env.PATH = `${binDir}${path.delimiter}${savedPath}`
  try {
    const { client } = await connectClient()
    const result = await client.callTool({
      name: 'render_frame',
      arguments: { projectId: FILM_PROJECT_ID, t: 2.5, note: '开场构图', aspect_ratio: '9:16' },
    })
    const parts = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>
    assert.equal(parts.length, 2, 'text + image parts')
    assert.equal(parts[0].type, 'text')
    assert.match(String(JSON.parse(parts[0].text!).message), /请自检/)
    assert.equal(parts[1].type, 'image', 'render_frame result carries ImageContent')
    assert.equal(parts[1].mimeType, 'image/jpeg')
    assert.equal(Buffer.from(parts[1].data!, 'base64').toString(), 'fake-jpeg')
    // 画幅换算经 --size 下发：9:16 → 1080x1920；时间点原样传
    const stubArgs = fs.readFileSync(path.join(filmDir, 'out', 'stub-args.txt'), 'utf8')
    assert.match(stubArgs, /--size 1080x1920/)
    assert.match(agentLogText(), /render_frame t=2\.5 \(开场构图\)/)
    assert.match(agentLogText(), /render_frame ok → agent_\d+_2\.5\.jpg/)
  } finally {
    process.env.PATH = savedPath
  }
})

test('run_blender: BLENDER_PATH 探测 → 无头执行 → ImageContent 回传 PNG', async () => {
  const blenderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-blender-'))
  const exe = stubScript(blenderDir, 'blender', [
    '# 测试桩：`--` 之后的第一个参数是输出图绝对路径，写出假 PNG',
    'out=""',
    'prev=""',
    'for a in "$@"; do',
    '  if [ "$prev" = "--" ]; then out="$a"; break; fi',
    '  prev="$a"',
    'done',
    'printf "stub-png-bytes" > "$out"',
    'echo "stub blender rendered to $out"',
  ])
  const saved = process.env.BLENDER_PATH
  process.env.BLENDER_PATH = exe
  try {
    const { client } = await connectClient()
    await client.callTool({
      name: 'write_file',
      arguments: { projectId: FILM_PROJECT_ID, path: 'build_asset.py', content: 'print("bpy")' },
    })
    const result = await client.callTool({
      name: 'run_blender',
      arguments: { projectId: FILM_PROJECT_ID, script: 'build_asset.py', output_image: 'out/asset.png', args: ['seed=7'] },
    })
    const parts = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>
    assert.equal(parts[1]?.type, 'image', 'run_blender result carries ImageContent')
    assert.equal(parts[1].mimeType, 'image/png')
    assert.equal(Buffer.from(parts[1].data!, 'base64').toString(), 'stub-png-bytes')
    assert.match(String(JSON.parse(parts[0].text!).message), /Blender 渲染完成/)
    assert.match(agentLogText(), /run_blender build_asset\.py seed=7/)
    assert.match(agentLogText(), /run_blender ok /)
  } finally {
    process.env.BLENDER_PATH = saved
  }
})

test('run_blender: 未检测到 Blender / 脚本不存在 → error 结果', async () => {
  const blenderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-blender-'))
  const exe = stubScript(blenderDir, 'blender', ['exit 0'])
  const saved = process.env.BLENDER_PATH
  try {
    const { client } = await connectClient()
    // 非空 override 不可执行 → null（不静默回落候选路径，探测结果确定）
    process.env.BLENDER_PATH = path.join(os.tmpdir(), 'definitely-not-blender')
    const noBlender = await client.callTool({
      name: 'run_blender',
      arguments: { projectId: FILM_PROJECT_ID, script: 'x.py', output_image: 'out/x.png' },
    })
    assert.match(String((await parseTextContent(noBlender)).error), /未检测到 Blender/)

    process.env.BLENDER_PATH = exe
    const missingScript = await client.callTool({
      name: 'run_blender',
      arguments: { projectId: FILM_PROJECT_ID, script: 'missing.py', output_image: 'out/x.png' },
    })
    assert.match(String((await parseTextContent(missingScript)).error), /脚本不存在：missing\.py/)
  } finally {
    process.env.BLENDER_PATH = saved
    if (!saved) delete process.env.BLENDER_PATH
  }
})

test('pipeline_start: 建创意流程（revision 服务端取当前），重复建立返回 error', async () => {
  const { createCreativeDocument } = await import('../../src/drama/services/creative-model.js')
  const document = createCreativeDocument('explainer')
  document.brief.idea = '黑洞是什么'
  document.brief.targetDuration = 30
  const ts = new Date().toISOString()
  const dramaId = getInsertId(await db.insert(schema.dramas).values({
    title: 'MCP 管线测试', projectType: 'creative', creativeCategory: 'explainer', createdAt: ts, updatedAt: ts,
  }).returning({ id: schema.dramas.id }))
  await db.insert(schema.creativeProjects).values({
    projectId: dramaId, document: JSON.stringify(document), revision: 1, updatedAt: ts,
  })

  const { client } = await connectClient()
  const started = await client.callTool({ name: 'pipeline_start', arguments: { drama_id: dramaId } })
  const state = await parseTextContent(started)
  assert.ok(state.run, 'run created by the EP tool')
  assert.equal(state.run.projectId, dramaId)
  assert.ok(state.definition?.stages?.length, 'definition attached to the run')
  assert.notEqual(state.run.status, 'ready', 'EP starts the run immediately')
  pipelineRunId = state.run.id

  const again = await client.callTool({ name: 'pipeline_start', arguments: { drama_id: dramaId } })
  assert.match(String((await parseTextContent(again)).error), /已建立过制作流程/)
})

test('pipeline_start 带 idea：对话主题写入 brief（revision bump），research 挂起等待宿主车道', async () => {
  const { createCreativeDocument } = await import('../../src/drama/services/creative-model.js')
  const document = createCreativeDocument('explainer')
  const ts = new Date().toISOString()
  const dramaId = getInsertId(await db.insert(schema.dramas).values({
    title: 'MCP 无主题项目', projectType: 'creative', creativeCategory: 'explainer', createdAt: ts, updatedAt: ts,
  }).returning({ id: schema.dramas.id }))
  await db.insert(schema.creativeProjects).values({
    projectId: dramaId, document: JSON.stringify(document), revision: 1, updatedAt: ts,
  })

  const { client } = await connectClient()
  const started = await client.callTool({
    name: 'pipeline_start', arguments: { drama_id: dramaId, idea: '用 60 秒解释什么是引力波' },
  })
  const state = await parseTextContent(started)
  assert.ok(state.run, 'run created')
  assert.equal(state.run.revision, 2, 'idea 写入经 saveCreativeProject 乐观锁 bump revision')
  // 首阶段异步执行：等它落到确定态。本断言只锁本轮契约——idea 门槛放行
  // （失败若发生，不再是「缺少制作主题」）；完成路径的 CAS 竞态是主网存量问题。
  let status = state.run.status
  let error: string | null = state.run.error ?? null
  for (let i = 0; i < 50 && !['waiting', 'review', 'failed', 'completed'].includes(status); i++) {
    await new Promise(resolve => setTimeout(resolve, 100))
    const fresh = await getPipelineState(dramaId)
    status = fresh.run!.status
    error = fresh.run!.error
  }
  assert.notEqual(status, 'ready')
  assert.ok(!/缺少制作主题/.test(error ?? ''), `idea gate must pass, got: ${error}`)
})

// ─── /mcp 路由鉴权（Hono app.request 直打） ───────────────────────

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } },
})
const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
}

test('/mcp: 无令牌 403，错令牌 403，未配置 env 403（fail-closed）', async () => {
  const noToken = await mcpRoute.request('/', { method: 'POST', headers: MCP_HEADERS, body: INIT_BODY })
  assert.equal(noToken.status, 403)

  const wrong = await mcpRoute.request('/', {
    method: 'POST', headers: { ...MCP_HEADERS, authorization: 'Bearer wrong-token' }, body: INIT_BODY,
  })
  assert.equal(wrong.status, 403)

  const saved = process.env.AI_DRAMA_MCP_TOKEN
  delete process.env.AI_DRAMA_MCP_TOKEN
  try {
    const unset = await mcpRoute.request('/', {
      method: 'POST', headers: { ...MCP_HEADERS, authorization: 'Bearer test-token' }, body: INIT_BODY,
    })
    assert.equal(unset.status, 403)
  } finally {
    process.env.AI_DRAMA_MCP_TOKEN = saved
  }
})

test('/mcp: 正确令牌的 initialize 走通 streamable HTTP（JSON 响应）', async () => {
  const res = await mcpRoute.request('/', {
    method: 'POST', headers: { ...MCP_HEADERS, authorization: 'Bearer test-token' }, body: INIT_BODY,
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal((await body).result.serverInfo.name, 'ai-drama')
})

test('/mcp: 无状态模式 GET 返回 405', async () => {
  const res = await mcpRoute.request('/', {
    method: 'GET', headers: { ...MCP_HEADERS, authorization: 'Bearer test-token' },
  })
  assert.equal(res.status, 405)
})

after(async () => {
  pipelineRunner.dispose()
  // 等在途 worker 归位再关池，否则 drop 撞上活跃会话（55006）
  if (pipelineRunId) await pipelineRunner.idle(pipelineRunId).catch(() => {})
  await db.$client.end()
  process.env.DATABASE_URL = __base
  await __admin.query(`DROP DATABASE IF EXISTS "${__dbName}"`)
  await __admin.end()
})
