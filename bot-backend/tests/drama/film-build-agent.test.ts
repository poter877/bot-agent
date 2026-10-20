/**
 * film build 编排壳契约测试 — runBuildAgent 改走 hermes gateway 后锁定：
 * - instructions（system 消息）携带工程契约/风格不变量/工具使用说明（含 project_id）
 * - messages 为任务描述；超时预算对齐原本地循环（30 分钟，分钟级）
 * - 产出文件清单从 agent.log 的工具日志行收集（hermes 侧 MCP 工具写同一份日志）；
 *   模型未调工具时兜底解析代码块落盘；两者皆无 → FilmError
 * - readFilmAgentLog 增量读取不变
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE_URL = 'https://hermes.invalid'
process.env.HERMES_AGENT_URL = BASE_URL
process.env.HERMES_AGENT_KEY = 'hermes-token'

const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'film-build-agent-'))
import { Pool } from 'pg'
const __base = process.env.DATABASE_URL
if (!__base) throw new Error('tests need DATABASE_URL (point at the test cluster, e.g. bot_backend_test)')
const __admin = new Pool({ connectionString: __base })
const __dbName = 'drama_' + process.pid + '_' + (Date.now() % 1000000)
await __admin.query(`CREATE DATABASE "${__dbName}" TEMPLATE bot_backend_test`)
process.env.DATABASE_URL = __base.replace(/\/[^/?]+$/, `/${__dbName}`)
process.env.STORAGE_PATH = path.join(dir, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
if (process.env.BLENDER_PATH) delete process.env.BLENDER_PATH

const { runBuildAgent, readFilmAgentLog, collectWrittenFiles, BUILD_AGENT_TIMEOUT_MS } = await import('../../src/drama/services/film-pipeline/build-agent.js')
const { STORAGE_ROOT } = await import('../../src/drama/utils/paths.js')

const PROJECT_ID = 777
const projectDir = path.join(STORAGE_ROOT, 'films', String(PROJECT_ID))
const agentLogPath = path.join(projectDir, 'agent.log')

function buildInput(overrides: Partial<Parameters<typeof runBuildAgent>[0]> = {}) {
  return {
    projectId: PROJECT_ID,
    styleSlug: 'ink-wash',
    styleMd: '## 1. 风格不变量\n- 水墨晕染',
    systemExtra: '画幅 16:9；时长目标 12 秒；语言 zh。',
    topic: '雨巷',
    language: 'zh',
    durationSec: 12,
    aspectRatio: '16:9',
    acceptedContent: '## treatment\n已确认的导演阐述',
    ...overrides,
  }
}

interface Captured {
  url: string
  body: Record<string, unknown>
}

/** mock gateway fetch；sideEffects 在请求到达时模拟 hermes 侧工具调用（MCP 写 agent.log + 工程文件） */
function captureGateway(response: () => string, sideEffects?: () => void) {
  const captured: Captured[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    captured.push({ url: String(input), body: JSON.parse(init?.body) })
    sideEffects?.()
    return Response.json({ choices: [{ message: { role: 'assistant', content: response() } }] })
  }) as typeof fetch
  return { captured, restore: () => { globalThis.fetch = original } }
}

test('runBuildAgent 经 runHermesAgent 编排：instructions/messages/超时预算 + 日志收集产出清单', async () => {
  const mock = captureGateway(
    () => '工程已完成：index.html 与 ink.js，渲帧自检通过。',
    () => {
      // 模拟 hermes 侧经 MCP 调 write_file 的落盘效果（同一进程、同一份 agent.log）
      const log = `${new Date().toISOString()} write_file index.html (5321 chars)\n`
        + `${new Date().toISOString()} render_frame t=3.0 (构图自检)\n`
        + `${new Date().toISOString()} write_file ink.js (2 chars)\n`
        + `${new Date().toISOString()} write_file index.html (9000 chars)\n`
      fs.mkdirSync(projectDir, { recursive: true })
      fs.appendFileSync(agentLogPath, log)
      fs.writeFileSync(path.join(projectDir, 'index.html'), '<html>ok</html>')
    },
  )
  try {
    const build = await runBuildAgent(buildInput())
    assert.deepEqual(build.files, ['index.html', 'ink.js'], 'files 从 agent.log 工具行收集并去重')
    assert.match(build.summary, /工程已完成/)

    assert.equal(mock.captured.length, 1, '一次 gateway 调用')
    const [request] = mock.captured
    assert.equal(request.url, `${BASE_URL}/v1/chat/completions`)
    const [system, user] = request.body.messages as { role: string; content: string }[]
    assert.equal(system.role, 'system')
    assert.equal(user.role, 'user')

    // instructions：工程规范 + 风格约束 + 工具使用说明（project_id 显式）
    assert.match(system.content, /你是影片工程搭建师/)
    assert.match(system.content, /=== 风格不变量（逐条遵守）===/)
    assert.match(system.content, /水墨晕染/)
    assert.match(system.content, /=== 工程契约（必须满足）===/)
    assert.match(system.content, /window\.DUR（秒）、window\.render\(t\)/)
    assert.match(system.content, /无 Date\.now\(\)、无未播种随机/)
    assert.match(system.content, /write_file/)
    assert.match(system.content, /用 write_file 在影片工程目录写 index\.html/)
    assert.match(system.content, /=== 导演阐述（已确认）===/)
    assert.doesNotMatch(system.content, /ToolLoopAgent/)

    // messages：任务描述（原 user prompt），project_id 告知工具入参
    assert.match(user.content, /主题\/故事素材：雨巷/)
    assert.match(user.content, /project_id=777/)
    assert.match(user.content, /先列出文件计划/)
    assert.match(user.content, /render_frame/)

    // agent.log：编排壳自己的日志行与工具行同文件累积
    const logText = fs.readFileSync(agentLogPath, 'utf8')
    assert.match(logText, /build agent 启动：style=ink-wash 时长=12s 画幅=16:9/)
    assert.match(logText, /开始生成…/)
    assert.match(logText, /agent 结束/)

    // readFilmAgentLog 增量读取链路不变
    const first = readFilmAgentLog(PROJECT_ID, 0)
    assert.equal(first.size, fs.statSync(agentLogPath).size)
    assert.equal(readFilmAgentLog(PROJECT_ID, first.size).content, '')
  } finally { mock.restore() }
})

test('兜底：模型未调工具时从最终文本提取代码块落盘；两者皆无则 FilmError', async () => {
  // 上一测试留下过工程文件：兜底路径要求 index.html 不存在才触发，先清场
  fs.rmSync(projectDir, { recursive: true, force: true })
  // 兜底落盘路径
  const fallback = captureGateway(() => '```html\n<html>DUR</html>\n```\n```js\nconsole.log(1)\n```')
  try {
    const build = await runBuildAgent(buildInput())
    assert.deepEqual(build.files, ['index.html', 'module_2.js'])
    // 代码块内容连同收尾换行一起落盘（与原本地循环的提取行为一致）
    assert.equal(fs.readFileSync(path.join(projectDir, 'index.html'), 'utf8'), '<html>DUR</html>\n')
    assert.match(fs.readFileSync(agentLogPath, 'utf8'), /fallback 落盘: index\.html/)
  } finally { fallback.restore() }

  // 什么都没产出 → FilmError（502）
  fs.rmSync(projectDir, { recursive: true, force: true })
  const empty = captureGateway(() => '我做不了这个。')
  try {
    await assert.rejects(runBuildAgent(buildInput()), (e: Error & { status?: number }) => {
      assert.match(e.message, /build 结束但工程缺少 index\.html/)
      assert.equal(e.status, 502)
      return true
    })
  } finally { empty.restore() }
})

test('collectWrittenFiles：write_file/generate_texture 行收集、归一化、保序去重', () => {
  const log = [
    '2026-10-15T10:00:00.000Z build agent 启动：style=ink-wash 时长=12s 画幅=16:9',
    '2026-10-15T10:00:01.000Z write_file index.html (5321 chars)',
    '2026-10-15T10:00:02.000Z render_frame t=3 (构图)',
    '2026-10-15T10:00:02.500Z render_frame ok → agent_123456_3.jpg (220KB)',
    '2026-10-15T10:00:03.000Z write_file ./ink.js (120 chars)',
    '2026-10-15T10:00:04.000Z generate_texture ok → assets/rust.png (245KB image/png)',
    '2026-10-15T10:00:05.000Z write_file index.html (9000 chars)',
    '2026-10-15T10:00:06.000Z agent 结束',
  ].join('\n')
  assert.deepEqual(collectWrittenFiles(log), ['index.html', 'ink.js', 'assets/rust.png'])
  assert.deepEqual(collectWrittenFiles(''), [])
})

test('超时预算：对齐原本地循环的 30 分钟（分钟级长任务预算）', () => {
  assert.equal(BUILD_AGENT_TIMEOUT_MS, 30 * 60_000)
})

after(async () => { process.env.DATABASE_URL = __base; await __admin.query(`DROP DATABASE IF EXISTS "${__dbName}"`); await __admin.end(); })
