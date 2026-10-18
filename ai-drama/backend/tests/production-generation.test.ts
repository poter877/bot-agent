import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'production-generation-'))
process.env.SQLITE_PATH = path.join(dir, 'test.sqlite')
process.env.STORAGE_PATH = path.join(dir, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema, getInsertId } = await import('../src/db/index.js')
const { generateImage, resumeGenerationTask } = await import('../src/services/generation.js')
const { providerDependencies } = await import('../src/services/production-tools/provider-runtime.js')
const { providerToolSpecs } = await import('../src/services/production-tools/providers.js')
const { runUnifiedGeneration } = await import('../src/services/production-tools/executor.js')
await fs.mkdir(path.join(dir, 'static'), { recursive: true })
const original = { ...providerDependencies }
after(async () => {
  Object.assign(providerDependencies, original)
  await fs.rm(dir, { recursive: true, force: true })
})
async function terminal(id: number) {
  for (let n = 0; n < 100; n++) {
    const row = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
    if (['failed', 'completed'].includes(row.status!)) return row
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('generation did not finish')
}

test('new model providers use the original image task lifecycle and write back real assets', async () => {
  const now = new Date().toISOString(),
    projectId = getInsertId(
      db.insert(schema.dramas).values({ title: '模型共享', createdAt: now, updatedAt: now }).run(),
    )
  const characterId = getInsertId(
    db
      .insert(schema.characters)
      .values({ dramaId: projectId, name: '角色', createdAt: now, updatedAt: now })
      .run(),
  )
  const model = providerToolSpecs.flux_image.model
  const configId = getInsertId(
    db
      .insert(schema.aiServiceConfigs)
      .values({
        serviceType: 'image',
        provider: 'fal',
        name: 'Fal shared',
        baseUrl: 'https://queue.fal.run',
        apiKey: 'test-secret',
        model: JSON.stringify([model]),
        createdAt: now,
        updatedAt: now,
      })
      .run(),
  )
  const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#556677' } })
    .png()
    .toBuffer()
  let posts = 0
  providerDependencies.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      posts++
      assert.equal(new Headers(init.headers).get('authorization'), 'Key test-secret')
      return Response.json({ request_id: 'known-job' })
    }
    if (String(url).endsWith('/status')) return Response.json({ status: 'COMPLETED' })
    return Response.json({ images: [{ url: 'https://fal.media/image.png' }] })
  }
  providerDependencies.download = async () => image
  const id = await generateImage({ dramaId: projectId, characterId, prompt: '测试人物', configId })
  const row = await terminal(id)
  assert.equal(row.status, 'completed')
  assert.equal(posts, 1)
  assert.match(row.localPath!, /^static\/production\//)
  assert.equal(
    db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).get()!.imageUrl,
    row.localPath,
  )
  assert.equal(JSON.parse(row.params!).snapshotConfigId, configId)
  assert.equal((await fs.stat(path.join(dir, row.localPath!))).size, image.length)
})

test('restarting a failed provider query uses its saved account and remote ID without a second generation POST', async () => {
  const previous = db.select().from(schema.aiServiceConfigs).get()!,
    now = new Date().toISOString()
  let posts = 0,
    fail = true
  providerDependencies.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      posts++
      return Response.json({ request_id: 'resume-job' })
    }
    if (fail) return new Response('', { status: 500 })
    if (String(url).endsWith('/status')) return Response.json({ status: 'COMPLETED' })
    return Response.json({ images: [{ url: 'https://fal.media/recovered.png' }] })
  }
  const id = await generateImage({ prompt: '恢复', configId: previous.id })
  let row = await terminal(id)
  assert.equal(row.status, 'failed')
  assert.equal(row.taskId, 'resume-job')
  db.insert(schema.aiServiceConfigs)
    .values({
      serviceType: 'image',
      provider: 'fal',
      name: 'Other account',
      baseUrl: 'https://queue.fal.run',
      apiKey: 'another-secret',
      model: previous.model,
      priority: 100,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  fail = false
  await resumeGenerationTask(id)
  row = await terminal(id)
  assert.equal(row.status, 'completed')
  assert.equal(posts, 1)
})

test('unified generation keeps the snapshotted model when the saved account model changes', async () => {
  const config = db.select().from(schema.aiServiceConfigs).get()!,
    project = db.select().from(schema.dramas).get()!,
    model = providerToolSpecs.flux_image.model,
    state: Record<string, unknown> = {},
    outputDir = path.join(dir, 'snapshot-output')
  await fs.mkdir(outputDir)
  db.update(schema.aiServiceConfigs)
    .set({ model: '["changed-model"]' })
    .where(eq(schema.aiServiceConfigs.id, config.id))
    .run()
  providerDependencies.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      assert.ok(String(url).includes(model))
      return Response.json({ request_id: 'snapshot-job' })
    }
    if (String(url).endsWith('/status')) return Response.json({ status: 'COMPLETED' })
    return Response.json({ images: [{ url: 'https://fal.media/snapshot.png' }] })
  }
  const result = await runUnifiedGeneration(
    {
      projectId: project.id,
      toolId: 'image_gen',
      args: { prompt: '模型快照' },
      outputDir,
      signal: new AbortController().signal,
      progress: () => {},
      state,
      checkpoint: (value) => Object.assign(state, value),
      config: { id: config.id, provider: 'fal', baseUrl: config.baseUrl!, apiKey: config.apiKey!, model },
    },
    'image',
  )
  const task = db
    .select()
    .from(schema.sysTask)
    .where(eq(schema.sysTask.id, Number(state.taskId)))
    .get()!
  assert.equal(task.model, model)
  assert.equal(result.files.length, 1)
  assert.ok((await fs.stat(result.files[0].path)).size > 0)
})
