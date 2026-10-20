import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-chat-test-'))
import { Pool } from 'pg'
const __base = process.env.DATABASE_URL
if (!__base) throw new Error('tests need DATABASE_URL (point at the test cluster, e.g. bot_backend_test)')
const __admin = new Pool({ connectionString: __base })
const __dbName = 'drama_' + process.pid + '_' + (Date.now() % 1000000)
await __admin.query(`CREATE DATABASE "${__dbName}" TEMPLATE bot_backend_test`)
process.env.DATABASE_URL = __base.replace(/\/[^/?]+$/, `/${__dbName}`)
process.env.HUOBAO_DATA_DIR = dir
process.env.STORAGE_PATH = path.join(dir, 'static')
const { db, schema, getInsertId } = await import('../../src/drama/db/index.js')
const { createCreativeDocument } = await import('../../src/drama/services/creative-model.js')
const { getCreativeProject, saveCreativeProject, approveCreativeProject } = await import('../../src/drama/services/creative-projects.js')
const { chatWithCreativeProject, parseCreativeChatReply, listCreativeMessages } = await import('../../src/drama/services/creative-chat.js')
const { eq } = await import('drizzle-orm')
after(async () => { process.env.DATABASE_URL = __base; await __admin.query(`DROP DATABASE IF EXISTS "${__dbName}"`); await __admin.end(); await fs.rm(dir, { recursive: true, force: true }) })
async function create() {
  const ts = new Date().toISOString()
  const id = getInsertId(await db.insert(schema.dramas).values({ title: '聊天测试', projectType: 'creative', creativeCategory: 'product', createdAt: ts, updatedAt: ts }).returning().returning().returning().returning().returning().returning().returning().returning().returning({ id: schema.dramas.id }))
  const document = await createCreativeDocument()
  document.shots = [{ id: 'shot-one', title: '开场', duration: 5, visualPrompt: '产品特写', narration: '', caption: '', mediaType: 'image', imageUrl: null, videoUrl: null, imageTaskId: null, videoTaskId: null, trimStart: 0, originalVolume: 1 }]
  await db.insert(schema.creativeProjects).values({ projectId: id, document: JSON.stringify(document), revision: 1, updatedAt: ts }).returning().returning().returning().returning().returning().returning().returning().returning()
  return getCreativeProject(id)
}
test('chat edits persist, retain shot identity, clear approval and keep history', async () => {
  const project = await create(); (await approveCreativeProject(project.id, 1))
  const result = await chatWithCreativeProject(project.id, 1, '开场改成6秒并加一句字幕', async () => JSON.stringify({
    content: '开场已调整为6秒。', actions: ['review'], changes: { shots: [{ id: 'shot-one', duration: 6, caption: '随时带走好温度' }] },
  }))
  assert.equal(result.project.revision, 2); assert.equal(result.project.approvedRevision, null)
  assert.equal(result.project.shots[0].id, 'shot-one'); assert.equal(result.project.shots[0].duration, 6)
  assert.equal(result.messages.length, 2); assert.deepEqual(result.message.actions, ['review'])
  assert.equal((await listCreativeMessages(project.id))[0].status, 'completed')
})
test('question-only reply does not change document revision or approval', async () => {
  const project = await create(); (await approveCreativeProject(project.id, 1))
  const result = await chatWithCreativeProject(project.id, 1, '下一步怎么做？', async () => '{"content":"打开素材制作，选择生成或上传。","actions":["generate"]}')
  assert.equal(result.project.revision, 1); assert.equal(result.project.approvedRevision, 1)
})
test('media, approvals and invented shot IDs cannot enter model edits', async () => {
  const project = await create()
  for (const changes of [
    { shots: [{ id: 'shot-one', imageUrl: '/static/uploads/elsewhere.png' }] },
    { approvedRevision: 1 }, { shots: [{ id: 'missing', duration: 4 }] }, { audio: { musicUrl: '/etc/passwd' } },
  ]) await assert.rejects(async () => parseCreativeChatReply(JSON.stringify({ content: '编辑', changes }), project))
  assert.equal((await getCreativeProject(project.id)).revision, 1)
})
test('failure preserves user message and document; retry succeeds', async () => {
  const project = await create()
  await assert.rejects(chatWithCreativeProject(project.id, 1, '修改', async () => 'invalid'), /回复格式/)
  assert.equal((await listCreativeMessages(project.id))[0].status, 'failed'); assert.equal((await getCreativeProject(project.id)).revision, 1)
  const result = await chatWithCreativeProject(project.id, 1, '修改', async () => '{"content":"已调整","changes":{"brief":{"tone":"轻松"}}}')
  assert.equal(result.project.brief.tone, '轻松')
})
test('concurrent edit prevents stale chat from overwriting a newer document', async () => {
  const project = await create()
  await assert.rejects(chatWithCreativeProject(project.id, 1, '改成温暖', async () => {
    saveCreativeProject(project.id, { ...project, revision: 1, brief: { ...project.brief, tone: '严谨' } })
    return '{"content":"已调整","changes":{"brief":{"tone":"温暖"}}}'
  }), /项目已被修改/)
  assert.equal((await getCreativeProject(project.id)).brief.tone, '严谨'); assert.equal((await listCreativeMessages(project.id)).at(-1)?.status, 'failed')
})
test('simultaneous chat is rejected and deleted projects cannot expose messages', async () => {
  const project = await create()
  let release!: (value: string) => void
  const pending = chatWithCreativeProject(project.id, 1, '想一想', () => new Promise(resolve => { release = resolve }))
  await assert.rejects(chatWithCreativeProject(project.id, 1, '再想一想'), /上一条消息/)
  await new Promise(resolve => { const timer = setInterval(() => { if (release) { clearInterval(timer); resolve(null) } }, 5) })  // 等首个调用推进到 generate（pg 异步化后的时序）
  release('{"content":"建议先明确受众。"}'); await pending
  await db.update(schema.dramas).set({ deletedAt: new Date().toISOString() }).where(eq(schema.dramas.id, project.id))
  await assert.rejects(async () => listCreativeMessages(project.id), /不存在/)
})

test('chat can edit category-specific requirements while preserving the source library', async () => {
  const project = await create()
  const result = await chatWithCreativeProject(project.id,1,'强调便携场景',async()=>JSON.stringify({content:'已更新产品要求',changes:{fields:{sellingPoints:'便携使用'}}}))
  assert.equal(result.project.production.fields.sellingPoints,'便携使用')
  assert.deepEqual(result.project.production.sources,project.production.sources)
  assert.equal(result.project.revision,2)
})
