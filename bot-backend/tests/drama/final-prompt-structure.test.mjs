import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { eq } from 'drizzle-orm'

const root = new URL('../../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const __base = process.env.DATABASE_URL
if (!__base) throw new Error('tests need DATABASE_URL (point at the test cluster, e.g. bot_backend_test)')
const __admin = new Pool({ connectionString: __base })
const __dbName = 'drama_' + process.pid + '_' + (Date.now() % 1000000)
await __admin.query(`CREATE DATABASE "${__dbName}" TEMPLATE bot_backend_test`)
process.env.DATABASE_URL = __base.replace(/\/[^/?]+$/, `/${__dbName}`)
process.env.COMPANY_BACKEND_URL = 'http://company.test'
process.env.COMPANY_SERVICE_TOKEN = 'test-token'
const { db, schema, getInsertId } = await import('../../src/drama/db/index.js')
after(async () => { (await db).$client.end(); process.env.DATABASE_URL = __base; await __admin.query(`DROP DATABASE IF EXISTS "${__dbName}"`); await __admin.end() })

test('characters and scenes tables store the model-written final prompt', () => {
  const schema = read('src/drama/db/schema.ts')

  assert.match(schema, /export const characters = [\s\S]*?finalPrompt: text\('final_prompt'\)/)
  assert.match(schema, /export const scenes = [\s\S]*?finalPrompt: text\('final_prompt'\)/)
  assert.match(schema, /export const props = [\s\S]*?finalPrompt: text\('final_prompt'\)/)
})

test('grid prompt agent tools save agent-written final prompts with style injection', () => {
  const tools = read('src/drama/agents/tools/image-prompt-tools.ts')

  assert.match(tools, /save_character_final_prompt/)
  assert.match(tools, /save_scene_final_prompt/)
  assert.match(tools, /getDramaStylePrompt/)
  assert.match(tools, /set\(\{ finalPrompt, updatedAt: now\(\) \}\)/)
  assert.doesNotMatch(tools, /generate_character_prompt/)
  assert.doesNotMatch(tools, /generate_scene_prompt/)
})

await test('final prompt service reuses stored prompts without any model call', async () => {
  const { ensureCharacterFinalPrompt, ensureSceneFinalPrompt } = await import('../../src/drama/services/final-prompt.js')

  const ts = new Date().toISOString()
  const dramaId = getInsertId(await db.insert(schema.dramas).values({ title: '最终提示词剧', createdAt: ts, updatedAt: ts }).returning())
  const episodeId = getInsertId(await db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts }).returning())
  const charWithPrompt = getInsertId(await db.insert(schema.characters).values({
    dramaId, name: '已生成角色', finalPrompt: '角色已存最终提示词', createdAt: ts, updatedAt: ts,
  }).returning())
  const sceneWithPrompt = getInsertId(await db.insert(schema.scenes).values({
    dramaId, location: '已生成场景', time: '日', prompt: 'p', finalPrompt: '场景已存最终提示词', createdAt: ts, updatedAt: ts,
  }).returning())
  const [char] = await db.select().from(schema.characters).where(eq(schema.characters.id, charWithPrompt))
  const [scene] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, sceneWithPrompt))

  let fetched = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => { fetched++; return new Response('{}') })
  try {
    assert.equal(await ensureCharacterFinalPrompt(char, episodeId), '角色已存最终提示词')
    assert.equal(await ensureSceneFinalPrompt(scene, episodeId), '场景已存最终提示词')
    assert.equal(fetched, 0)
  } finally {
    globalThis.fetch = originalFetch
  }

  // 服务形状：单发模型调用（《重构》清理：不再有 agent 编排与保存工具约定）
  const service = read('src/drama/services/final-prompt.ts')
  assert.match(service, /export async function ensureCharacterFinalPrompt/)
  assert.match(service, /export async function ensureSceneFinalPrompt/)
  assert.match(service, /await runTextModel\(\{/)
  assert.match(service, /force = false/)
  assert.doesNotMatch(service, /getAgent|runHermesAgent/)
})

// 路由回退链：生图优先最终提示词，缺失回退本地拼接
await test('image generation routes prefer stored final prompt with local fallback', async () => {
  const characters = read('src/drama/routes/characters.ts')
  const scenes = read('src/drama/routes/scenes.ts')
  assert.match(characters, /ensureCharacterFinalPrompt\(char, ep\.id, /)
  assert.match(characters, /model: body\.text_model, configId: body\.text_config_id/)
  assert.match(characters, /finalPrompt \|\| characterImagePrompt\(char, stylePrompt\)/)
  assert.match(scenes, /ensureSceneFinalPrompt\(scene, ep\.id, /)
  assert.match(scenes, /finalPrompt \|\| \[/)
  assert.match(characters, /body\.final_prompt !== undefined\) updates\.finalPrompt = body\.final_prompt \|\| null/)
  assert.match(scenes, /body\.final_prompt !== undefined\) updates\.finalPrompt = body\.final_prompt \|\| null/)
})

function eqCharId(id) { return eq(schema.characters.id, id) }
