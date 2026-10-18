import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { execFileSync } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { ffmpegPath } from '../src/utils/ffmpeg.js'
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'production-generation-'))
process.env.SQLITE_PATH = path.join(dir, 'test.sqlite')
process.env.STORAGE_PATH = path.join(dir, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.COMPANY_BACKEND_URL = 'https://company.invalid'
process.env.COMPANY_SERVICE_TOKEN = 'company-token'
const { db, schema, getInsertId } = await import('../src/db/index.js')
const { generateImage, generateVideo, resumeGenerationTask } = await import('../src/services/generation.js')
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
        baseUrl: 'https://company.invalid',
        apiKey: 'company-token',
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
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer company-token')
      assert.match(String(url), /\/api\/media\/queue$/)
      assert.equal(JSON.parse(String(init.body)).model, model)
      return Response.json({
        ok: true,
        request_id: 'known-job',
        assets: [{ media_type: 'image/png', base64: image.toString('base64') }],
      })
    }
    throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`)
  }
  const id = await generateImage({ dramaId: projectId, characterId, prompt: '测试人物', configId })
  const row = await terminal(id)
  assert.equal(row.status, 'completed')
  assert.equal(posts, 1)
  assert.equal(row.taskId, 'known-job')
  assert.match(row.localPath!, /^static\/production\//)
  assert.equal(
    db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).get()!.imageUrl,
    row.localPath,
  )
  assert.equal(JSON.parse(row.params!).snapshotConfigId, configId)
  assert.equal((await fs.stat(path.join(dir, row.localPath!))).size, image.length)
})

test('rerunning a failed queue generation uses its saved account snapshot and posts afresh', async () => {
  const previous = db.select().from(schema.aiServiceConfigs).get()!,
    now = new Date().toISOString()
  const image = await sharp({ create: { width: 48, height: 48, channels: 3, background: '#123321' } })
    .png()
    .toBuffer()
  let posts = 0
  providerDependencies.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      posts++
      if (posts === 1) return new Response('', { status: 500 })
      assert.match(String(url), /\/api\/media\/queue$/)
      return Response.json({
        ok: true,
        request_id: `retry-job-${posts}`,
        assets: [{ media_type: 'image/png', base64: image.toString('base64') }],
      })
    }
    throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`)
  }
  const id = await generateImage({ prompt: '恢复', configId: previous.id })
  let row = await terminal(id)
  assert.equal(row.status, 'failed')
  // 同步队列失败没有远端任务号：恢复走明确重发，而不是续查
  await assert.rejects(resumeGenerationTask(id), /没有服务商编号/)
  db.insert(schema.aiServiceConfigs)
    .values({
      serviceType: 'image',
      provider: 'fal',
      name: 'Other account',
      baseUrl: 'https://company.invalid',
      apiKey: 'company-token',
      model: previous.model,
      priority: 100,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  const rerun = await generateImage({ prompt: '恢复', configId: previous.id })
  row = await terminal(rerun)
  assert.equal(row.status, 'completed')
  assert.equal(posts, 2)
  assert.equal(row.taskId, 'retry-job-2')
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
      assert.match(String(url), /\/api\/media\/queue$/)
      // 快照模型随任务走：配置行后来改成 changed-model 也不影响本次提交
      assert.equal(JSON.parse(String(init.body)).model, model)
      const image = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#445566' } })
        .png()
        .toBuffer()
      return Response.json({
        ok: true,
        request_id: 'snapshot-job',
        assets: [{ media_type: 'image/png', base64: image.toString('base64') }],
      })
    }
    throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`)
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

test('company image generation posts the media contract and writes back the base64 asset', async () => {
  const now = new Date().toISOString(),
    projectId = getInsertId(
      db.insert(schema.dramas).values({ title: '公司图片', createdAt: now, updatedAt: now }).run(),
    )
  const configId = getInsertId(
    db
      .insert(schema.aiServiceConfigs)
      .values({
        serviceType: 'image',
        provider: 'company',
        name: '公司图片',
        baseUrl: 'https://company.invalid',
        apiKey: 'company-token',
        model: JSON.stringify(['catalog-image']),
        priority: 200,
        createdAt: now,
        updatedAt: now,
      })
      .run(),
  )
  const image = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#123456' } })
    .png()
    .toBuffer()
  const original = globalThis.fetch
  let request: { url: string; init: RequestInit } | undefined
  globalThis.fetch = (async (url, init) => {
    if (!String(url).startsWith('data:')) request = { url: String(url), init: init! }
    return Response.json({ ok: true, images: [{ media_type: 'image/png', base64: image.toString('base64') }] })
  }) as typeof fetch
  try {
    const id = await generateImage({ dramaId: projectId, prompt: '公司图片', configId })
    const row = await terminal(id)
    assert.equal(row.status, 'completed')
    assert.equal(row.provider, 'company')
    assert.match(request!.url, /\/api\/media\/image$/)
    assert.equal(new Headers(request!.init.headers).get('authorization'), 'Bearer company-token')
    assert.equal(JSON.parse(String(request!.init.body)).model, 'catalog-image')
    assert.equal((await fs.stat(path.join(dir, row.localPath!))).size, image.length)
  } finally {
    globalThis.fetch = original
    db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, configId)).run()
  }
})

test('company video generation sends reference fields as JSON arrays and decodes the base64 video', async () => {
  const now = new Date().toISOString(),
    projectId = getInsertId(
      db.insert(schema.dramas).values({ title: '公司视频', createdAt: now, updatedAt: now }).run(),
    )
  const configId = getInsertId(
    db
      .insert(schema.aiServiceConfigs)
      .values({
        serviceType: 'video',
        provider: 'company',
        name: '公司视频',
        baseUrl: 'https://company.invalid',
        apiKey: 'company-token',
        model: JSON.stringify(['catalog-video']),
        priority: 200,
        createdAt: now,
        updatedAt: now,
      })
      .run(),
  )
  await fs.mkdir(path.join(dir, 'static'), { recursive: true })
  const videoFile = path.join(dir, 'static', 'video-fixture.mp4')
  execFileSync(ffmpegPath!, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10',
    '-t', '0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    videoFile,
  ])
  const video = await fs.readFile(videoFile)
  const original = globalThis.fetch
  let request: { url: string; init: RequestInit } | undefined
  globalThis.fetch = (async (url, init) => {
    if (String(url).startsWith('data:')) return original(url) // 落盘下载走真实 data: 解码
    request = { url: String(url), init: init! }
    return Response.json({ ok: true, videos: [{ media_type: 'video/mp4', base64: video.toString('base64') }] })
  }) as typeof fetch
  try {
    const id = await generateVideo({
      dramaId: projectId,
      prompt: '公司视频',
      configId,
      duration: 5,
      firstFrameUrl: 'data:image/png;base64,Zmlyc3QtZnJhbWU=',
      referenceImageUrls: ['data:image/png;base64,Zmlyc3QtZnJhbWU='],
      referenceVideoUrls: ['https://cdn.example.com/ref.mp4'],
      referenceAudioUrls: [],
      referenceFileUrl: 'https://cdn.example.com/ref.zip',
      generateAudio: false,
      resolution: '720p',
    })
    const row = await terminal(id)
    assert.equal(row.status, 'completed')
    assert.match(request!.url, /\/api\/media\/video$/)
    const body = JSON.parse(String(request!.init.body))
    // 参考列以 JSON 数组下发（不再是 JSON 字符串列），音频开关转布尔
    assert.deepEqual(body.referenceImages, ['data:image/png;base64,Zmlyc3QtZnJhbWU='])
    assert.deepEqual(body.referenceVideos, ['https://cdn.example.com/ref.mp4'])
    assert.equal('referenceAudios' in body, false)
    assert.equal(body.referenceFileUrl, 'https://cdn.example.com/ref.zip')
    assert.equal(body.firstFrameUrl, 'data:image/png;base64,Zmlyc3QtZnJhbWU=')
    assert.equal(body.generateAudio, false)
    assert.equal(body.resolution, '720p')
    assert.equal((await fs.readFile(path.join(dir, row.localPath!))).length, video.length)
  } finally {
    globalThis.fetch = original
    db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, configId)).run()
  }
})
