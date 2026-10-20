import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq } from 'drizzle-orm'

const root = new URL('../../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

// 行为测试经真实路由 + 临时 SQLite 库（env 先于动态导入设置）
import { Pool } from 'pg'
const __base = process.env.DATABASE_URL
if (!__base) throw new Error('tests need DATABASE_URL (point at the test cluster, e.g. bot_backend_test)')
const __admin = new Pool({ connectionString: __base })
const __dbName = 'drama_' + process.pid + '_' + (Date.now() % 1000000)
await __admin.query(`CREATE DATABASE "${__dbName}" TEMPLATE bot_backend_test`)
process.env.DATABASE_URL = __base.replace(/\/[^/?]+$/, `/${__dbName}`)
const { db, schema, getInsertId } = await import('../../src/drama/db/index.js')
const characters = (await import('../../src/drama/routes/characters.js')).default
const scenes = (await import('../../src/drama/routes/scenes.js')).default
const props = (await import('../../src/drama/routes/props.js')).default
after(async () => { process.env.DATABASE_URL = __base; await __admin.query(`DROP DATABASE IF EXISTS "${__dbName}"`); await __admin.end() })

const now = () => new Date().toISOString()
const makeDrama = async () => (await getInsertId((await db.insert(schema.dramas).values({ title: 'CRUD 测试剧', createdAt: (await now()), updatedAt: now() }).returning().returning().returning().returning().returning().returning().returning().returning())))
const makeEpisode = async (dramaId) => (await getInsertId((await db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: '第1集', createdAt: (await now()), updatedAt: now() }).returning().returning().returning().returning().returning().returning().returning().returning())))

async function request(app, url, method = 'GET', body) {
  const response = await app.request(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return { status: response.status, body: await response.json() }
}

test('characters route supports manual create and soft delete', async () => {
  const dramaId = makeDrama()
  const episodeId = await makeEpisode(dramaId)
  const source = read('src/drama/routes/characters.ts')

  // 手动新增校验：drama_id 与 name 必填（名称必填）
  assert.equal((await request(characters, '/', 'POST', { name: '缺剧集' })).status, 400)
  const missingName = await request(characters, '/', 'POST', { drama_id: dramaId })
  assert.equal(missingName.status, 400)
  assert.match(missingName.body.message, /名称必填/)

  // 传入 episode_id 时关联到该集
  const created = await request(characters, '/', 'POST', { drama_id: dramaId, name: ' 小李 ', episode_id: episodeId })
  assert.equal(created.status, 201)
  const id = created.body.data.id
  assert.equal(created.body.data.name, '小李')
  const link = (await (await db.select().from(schema.episodeCharacters)
    .where((await and((await eq(schema.episodeCharacters.episodeId, episodeId)), eq(schema.episodeCharacters.characterId, id)))))[0])
  assert.ok(link, 'episode_characters 关联行应存在')

  // 软删除：deleted_at 置位、行保留（保留历史生成记录）
  assert.equal((await request(characters, `/${id}`, 'DELETE')).status, 200)
  const row = (await (await db.select().from(schema.characters).where((await eq(schema.characters.id, id))))[0])
  assert.ok(row, '硬删除不应发生')
  assert.ok(row.deletedAt)
  assert.match(source, /deletedAt: now\(\)/)
  assert.doesNotMatch(source, /db\.delete\(schema\.characters\)/)
})

test('scenes route links new scenes to episode and soft deletes', async () => {
  const dramaId = makeDrama()
  const episodeId = await makeEpisode(dramaId)
  const source = read('src/drama/routes/scenes.ts')

  // 手动新增校验：drama_id 与地点必填
  assert.equal((await request(scenes, '/', 'POST', { location: '缺剧集' })).status, 400)
  const missingLocation = await request(scenes, '/', 'POST', { drama_id: dramaId })
  assert.equal(missingLocation.status, 400)
  assert.match(missingLocation.body.message, /地点必填/)

  // 传入 episode_id 时关联到该集
  const created = await request(scenes, '/', 'POST', { drama_id: dramaId, location: ' 天台 ', episode_id: episodeId })
  assert.equal(created.status, 201)
  const id = created.body.data.id
  const link = (await (await db.select().from(schema.episodeScenes)
    .where((await and((await eq(schema.episodeScenes.episodeId, episodeId)), eq(schema.episodeScenes.sceneId, id)))))[0])
  assert.ok(link, 'episode_scenes 关联行应存在')

  // 软删除（原为硬删，保留历史生成记录）
  assert.equal((await request(scenes, `/${id}`, 'DELETE')).status, 200)
  const row = (await (await db.select().from(schema.scenes).where((await eq(schema.scenes.id, id))))[0])
  assert.ok(row, '硬删除不应发生')
  assert.ok(row.deletedAt)
  assert.match(source, /deletedAt: now\(\)/)
  assert.doesNotMatch(source, /db\.delete\(schema\.scenes\)/)
})

test('props route supports manual create and soft delete', async () => {
  const dramaId = makeDrama()
  const episodeId = makeEpisode(dramaId)
  const source = read('src/drama/routes/props.ts')

  // 手动新增校验：drama_id 与 name 必填（名称必填）
  assert.equal((await request(props, '/', 'POST', { name: '缺剧集' })).status, 400)
  const missingName = await request(props, '/', 'POST', { drama_id: dramaId })
  assert.equal(missingName.status, 400)
  assert.match(missingName.body.message, /名称必填/)

  // 传入 episode_id 时关联到该集
  const created = await request(props, '/', 'POST', { drama_id: dramaId, name: ' 信物 ', type: '文件', episode_id: episodeId })
  assert.equal(created.status, 201)
  const id = created.body.data.id
  assert.equal(created.body.data.name, '信物')
  const link = (await (await db.select().from(schema.episodeProps)
    .where((await and((await eq(schema.episodeProps.episodeId, episodeId)), eq(schema.episodeProps.propId, id)))))[0])
  assert.ok(link, 'episode_props 关联行应存在')

  // 软删除
  assert.equal((await request(props, `/${id}`, 'DELETE')).status, 200)
  const row = (await (await db.select().from(schema.props).where((await eq(schema.props.id, id))))[0])
  assert.ok(row, '硬删除不应发生')
  assert.ok(row.deletedAt)
  assert.match(source, /deletedAt: now\(\)/)
  assert.doesNotMatch(source, /db\.delete\(schema\.props\)/)
})
