import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-chat-test-'))
process.env.SQLITE_PATH = path.join(dir, 'test.sqlite')
process.env.HUOBAO_DATA_DIR = dir
process.env.STORAGE_PATH = path.join(dir, 'static')
const { db, schema, getInsertId } = await import('../src/db/index.js')
const { createCreativeDocument } = await import('../src/services/creative-model.js')
const { getCreativeProject, saveCreativeProject, approveCreativeProject } = await import('../src/services/creative-projects.js')
const { chatWithCreativeProject, parseCreativeChatReply, listCreativeMessages } = await import('../src/services/creative-chat.js')
const { eq } = await import('drizzle-orm')
after(async () => { await fs.rm(dir, { recursive: true, force: true }) })
function create() {
  const ts = new Date().toISOString()
  const id = getInsertId(db.insert(schema.dramas).values({ title: '聊天测试', projectType: 'creative', creativeCategory: 'product', createdAt: ts, updatedAt: ts }).run())
  const document = createCreativeDocument()
  document.shots = [{ id: 'shot-one', title: '开场', duration: 5, visualPrompt: '产品特写', narration: '', caption: '', mediaType: 'image', imageUrl: null, videoUrl: null, imageTaskId: null, videoTaskId: null, trimStart: 0, originalVolume: 1 }]
  db.insert(schema.creativeProjects).values({ projectId: id, document: JSON.stringify(document), revision: 1, updatedAt: ts }).run()
  return getCreativeProject(id)
}
test('chat edits persist, retain shot identity, clear approval and keep history', async () => {
  const project = create(); approveCreativeProject(project.id, 1)
  const result = await chatWithCreativeProject(project.id, 1, '开场改成6秒并加一句字幕', async () => JSON.stringify({
    content: '开场已调整为6秒。', actions: ['review'], changes: { shots: [{ id: 'shot-one', duration: 6, caption: '随时带走好温度' }] },
  }))
  assert.equal(result.project.revision, 2); assert.equal(result.project.approvedRevision, null)
  assert.equal(result.project.shots[0].id, 'shot-one'); assert.equal(result.project.shots[0].duration, 6)
  assert.equal(result.messages.length, 2); assert.deepEqual(result.message.actions, ['review'])
  assert.equal(listCreativeMessages(project.id)[0].status, 'completed')
})
test('question-only reply does not change document revision or approval', async () => {
  const project = create(); approveCreativeProject(project.id, 1)
  const result = await chatWithCreativeProject(project.id, 1, '下一步怎么做？', async () => '{"content":"打开素材制作，选择生成或上传。","actions":["generate"]}')
  assert.equal(result.project.revision, 1); assert.equal(result.project.approvedRevision, 1)
})
test('media, approvals and invented shot IDs cannot enter model edits', () => {
  const project = create()
  for (const changes of [
    { shots: [{ id: 'shot-one', imageUrl: '/static/uploads/elsewhere.png' }] },
    { approvedRevision: 1 }, { shots: [{ id: 'missing', duration: 4 }] }, { audio: { musicUrl: '/etc/passwd' } },
  ]) assert.throws(() => parseCreativeChatReply(JSON.stringify({ content: '编辑', changes }), project))
  assert.equal(getCreativeProject(project.id).revision, 1)
})
test('failure preserves user message and document; retry succeeds', async () => {
  const project = create()
  await assert.rejects(chatWithCreativeProject(project.id, 1, '修改', async () => 'invalid'), /回复格式/)
  assert.equal(listCreativeMessages(project.id)[0].status, 'failed'); assert.equal(getCreativeProject(project.id).revision, 1)
  const result = await chatWithCreativeProject(project.id, 1, '修改', async () => '{"content":"已调整","changes":{"brief":{"tone":"轻松"}}}')
  assert.equal(result.project.brief.tone, '轻松')
})
test('concurrent edit prevents stale chat from overwriting a newer document', async () => {
  const project = create()
  await assert.rejects(chatWithCreativeProject(project.id, 1, '改成温暖', async () => {
    saveCreativeProject(project.id, { ...project, revision: 1, brief: { ...project.brief, tone: '严谨' } })
    return '{"content":"已调整","changes":{"brief":{"tone":"温暖"}}}'
  }), /项目已被修改/)
  assert.equal(getCreativeProject(project.id).brief.tone, '严谨'); assert.equal(listCreativeMessages(project.id).at(-1)?.status, 'failed')
})
test('simultaneous chat is rejected and deleted projects cannot expose messages', async () => {
  const project = create()
  let release!: (value: string) => void
  const pending = chatWithCreativeProject(project.id, 1, '想一想', () => new Promise(resolve => { release = resolve }))
  await assert.rejects(chatWithCreativeProject(project.id, 1, '再想一想'), /上一条消息/)
  release('{"content":"建议先明确受众。"}'); await pending
  db.update(schema.dramas).set({ deletedAt: new Date().toISOString() }).where(eq(schema.dramas.id, project.id)).run()
  assert.throws(() => listCreativeMessages(project.id), /不存在/)
})

test('chat can edit category-specific requirements while preserving the source library', async () => {
  const project = create()
  const result = await chatWithCreativeProject(project.id,1,'强调便携场景',async()=>JSON.stringify({content:'已更新产品要求',changes:{fields:{sellingPoints:'便携使用'}}}))
  assert.equal(result.project.production.fields.sellingPoints,'便携使用')
  assert.deepEqual(result.project.production.sources,project.production.sources)
  assert.equal(result.project.revision,2)
})
