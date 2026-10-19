import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'

const root = new URL('../../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

// 行为测试共用一个临时 SQLite 库（模块缓存的 db 实例只绑定首个 SQLITE_PATH，
// 故 env 必须先于第一个动态导入设置；hermes 客户端 env 为惰性读取，指到 invalid 即可）
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'final-prompt-'))
process.env.SQLITE_PATH = path.join(directory, 'test.sqlite')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.HERMES_AGENT_URL = 'https://hermes.invalid'
process.env.HERMES_AGENT_KEY = 'hermes-token'
const { db, schema, getInsertId } = await import('../../src/drama/db/index.js')
after(async () => { await fs.rm(directory, { recursive: true, force: true }) })

test('characters and scenes tables store the agent-written final prompt', () => {
  const schema = read('src/drama/db/schema.ts')
  const sqliteSchema = read('src/drama/db/sqlite-schema.ts')

  // Drizzle 表定义（MySQL→SQLite 迁移后由 sqliteTable 承接；道具同族字段一并锁定）
  assert.match(schema, /export const characters = sqliteTable\('characters'[\s\S]*?finalPrompt: text\('final_prompt'\)/)
  assert.match(schema, /export const scenes = sqliteTable\('scenes'[\s\S]*?finalPrompt: text\('final_prompt'\)/)
  assert.match(schema, /export const props = sqliteTable\('props'[\s\S]*?finalPrompt: text\('final_prompt'\)/)
  // 建表 DDL 携带 final_prompt 列（MySQL 时代的加列 backfill 断言由 SQLite 初始 schema 含列承接：
  // 旧库整库经 mysql-import 白名单导入，列在导入前已由 DDL 建好）
  assert.match(sqliteSchema, /CREATE TABLE IF NOT EXISTS characters \([\s\S]*?final_prompt TEXT/)
  assert.match(sqliteSchema, /CREATE TABLE IF NOT EXISTS scenes \([\s\S]*?final_prompt TEXT/)
  assert.match(sqliteSchema, /CREATE TABLE IF NOT EXISTS props \([\s\S]*?final_prompt TEXT/)
})

test('grid prompt agent tools save agent-written final prompts with style injection', () => {
  const tools = read('src/drama/agents/tools/image-prompt-tools.ts')

  assert.match(tools, /save_character_final_prompt/)
  assert.match(tools, /save_scene_final_prompt/)
  // 保存时注入项目视觉风格并落库
  assert.match(tools, /getDramaStylePrompt/)
  assert.match(tools, /set\(\{ finalPrompt, updatedAt: now\(\) \}\)/)
  // 提示词由 Agent 创作，不再由工具机械拼接
  assert.doesNotMatch(tools, /generate_character_prompt/)
  assert.doesNotMatch(tools, /generate_scene_prompt/)
})

test('prompt agent instructions are assembled per request from the workspace prompt file plus skill files', async () => {
  // hermes 编排后 instructions 不再是代码常量：按请求解析
  // workspace/prompts/prompt_generator.md（缺失时回退 DEFAULT_PROMPTS）+ 技能全文拼接。
  // 拦截 hermes gateway fetch，捕获实际下发的 system 消息锁装配结果。
  const { getAgent } = await import('../../src/drama/agents/index.js')

  const captured = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_input, init) => {
    captured.push(JSON.parse(init?.body))
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })
  })
  try {
    const agent = await getAgent('prompt_generator', { episodeId: 7, dramaId: 3 })
    await agent.generate({ messages: [{ role: 'user', content: '生成测试消息' }] })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(captured.length, 1)
  const messages = captured[0].messages
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'system')
  const instructions = messages[0].content
  // prompt 文件承载三类图片规范入口 + 保存工具约定（具体创作规则在各自 SKILL.md）
  assert.match(instructions, /角色三视图/)
  assert.match(instructions, /场景固定视角/)
  assert.match(instructions, /道具白底单品/)
  assert.match(instructions, /save_character_final_prompt/)
  assert.match(instructions, /save_scene_final_prompt/)
  assert.match(instructions, /save_prop_final_prompt/)
  // 技能全文动态拼接进入指令（这些规范只存在于 SKILL.md，证明技能注入生效）
  assert.match(instructions, /正脸特写/)
  assert.match(instructions, /三个视图的脸、发型和服装完全一致/)
  assert.match(instructions, /固定机位广角镜头/)
  // 会话隔离任务标识随指令下发（episode 上下文 → [task: episode-7]）
  assert.match(instructions, /\n\[task: episode-7\]$/)
  // 用户消息随行
  assert.equal(messages[1].content, '生成测试消息')

  // 代码默认值兜底同契约（workspace/prompts 文件缺失时的回退源不再丢保存工具约定）
  const agents = read('src/drama/agents/index.ts')
  assert.match(agents, /save_character_final_prompt/)
  assert.match(agents, /save_scene_final_prompt/)
  assert.match(agents, /角色三视图/)
})

test('image generation prefers the stored final prompt with agent generation and legacy fallback', async () => {
  const { ensureCharacterFinalPrompt, ensureSceneFinalPrompt } = await import('../../src/drama/services/final-prompt.js')

  const ts = new Date().toISOString()
  const dramaId = getInsertId(db.insert(schema.dramas).values({ title: '最终提示词剧', createdAt: ts, updatedAt: ts }).run())
  const episodeId = getInsertId(db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts }).run())
  const charWithPrompt = getInsertId(db.insert(schema.characters).values({
    dramaId, name: '已生成角色', finalPrompt: '角色已存最终提示词', createdAt: ts, updatedAt: ts,
  }).run())
  const charWithoutPrompt = getInsertId(db.insert(schema.characters).values({
    dramaId, name: '未生成角色', createdAt: ts, updatedAt: ts,
  }).run())
  const sceneWithPrompt = getInsertId(db.insert(schema.scenes).values({
    dramaId, location: '已生成场景', time: '日', prompt: 'p', finalPrompt: '场景已存最终提示词', createdAt: ts, updatedAt: ts,
  }).run())
  const char = db.select().from(schema.characters).where(eq(schema.characters.id, charWithPrompt)).get()
  const bareChar = db.select().from(schema.characters).where(eq(schema.characters.id, charWithoutPrompt)).get()
  const scene = db.select().from(schema.scenes).where(eq(schema.scenes.id, sceneWithPrompt)).get()

  const gatewayCalls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_input, init) => {
    gatewayCalls.push(JSON.parse(init?.body))
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })
  })
  try {
    // 已有最终提示词直接复用：不触发 agent（不发起 gateway 请求）
    assert.equal(await ensureCharacterFinalPrompt(char, episodeId), '角色已存最终提示词')
    assert.equal(await ensureSceneFinalPrompt(scene, episodeId), '场景已存最终提示词')
    assert.equal(gatewayCalls.length, 0)
    // force 时忽略已有提示词强制重新生成：走一次 gateway，完成后回读数据库现值
    assert.equal(await ensureCharacterFinalPrompt(char, episodeId, true), '角色已存最终提示词')
    assert.equal(gatewayCalls.length, 1)
    // 缺失时经 agent 生成：gateway 请求要求调用保存工具；mock 侧工具未落库 → 按契约返回 ''
    // （调用方回退到本地拼接提示词）
    const message = gatewayCalls.at(-1).messages.at(-1).content
    assert.match(message, /save_character_final_prompt/)
    assert.equal(await ensureCharacterFinalPrompt(bareChar, episodeId), '')
  } finally {
    globalThis.fetch = originalFetch
  }

  // 服务形状：经 prompt_generator Agent，force 缺省 false；场景/角色各有保存工具指令
  const service = read('src/drama/services/final-prompt.ts')
  assert.match(service, /export async function ensureCharacterFinalPrompt/)
  assert.match(service, /export async function ensureSceneFinalPrompt/)
  assert.match(service, /getAgent\('prompt_generator'/)
  assert.match(service, /force = false/)
  assert.match(service, /调用 save_scene_final_prompt 保存/)

  // 路由回退链：生图优先最终提示词，缺失回退本地拼接；文本模型覆盖（text_model/text_config_id）透传
  const characters = read('src/drama/routes/characters.ts')
  const scenes = read('src/drama/routes/scenes.ts')
  assert.match(characters, /ensureCharacterFinalPrompt\(char, ep\.id, /)
  assert.match(characters, /model: body\.text_model, configId: body\.text_config_id/)
  assert.match(characters, /finalPrompt \|\| characterImagePrompt\(char, stylePrompt\)/)
  assert.match(scenes, /ensureSceneFinalPrompt\(scene, ep\.id, /)
  assert.match(scenes, /finalPrompt \|\| \[/)
  // 最终提示词编辑契约（现行语义）：显式传值才覆盖（空串置 null），未传入保留原值——
  // 旧「编辑描述即自动置空」的 updates.finalPrompt = null 写法已废除
  assert.match(characters, /body\.final_prompt !== undefined\) updates\.finalPrompt = body\.final_prompt \|\| null/)
  assert.match(scenes, /body\.final_prompt !== undefined\) updates\.finalPrompt = body\.final_prompt \|\| null/)
  assert.doesNotMatch(characters, /updates\.finalPrompt = null/)
  assert.doesNotMatch(scenes, /updates\.finalPrompt = null/)
})
