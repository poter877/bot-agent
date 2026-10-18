import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'production-transcription-'))
process.env.SQLITE_PATH = path.join(dir, 'test.sqlite')
process.env.STORAGE_PATH = path.join(dir, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema, getInsertId } = await import('../src/db/index.js')
const { createCreativeDocument } = await import('../src/services/creative-model.js')
const { createToolboxService, listToolboxJobs } = await import('../src/services/production-tools/jobs.js')
const { executeTool } = await import('../src/services/production-tools/executor.js')
const { providerDependencies } = await import('../src/services/production-tools/provider-runtime.js')
const originalFetch = providerDependencies.fetch
const services: ReturnType<typeof createToolboxService>[] = []
const now = new Date().toISOString()
const configId = getInsertId(
  db
    .insert(schema.aiServiceConfigs)
    .values({
      serviceType: 'transcription',
      provider: 'openai',
      name: '字幕识别',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-secret',
      model: '["whisper-1"]',
      createdAt: now,
      updatedAt: now,
    })
    .run(),
)
async function project() {
  const id = getInsertId(
    db
      .insert(schema.dramas)
      .values({
        title: '字幕测试',
        projectType: 'creative',
        creativeCategory: 'explainer',
        createdAt: now,
        updatedAt: now,
      })
      .run(),
  )
  db.insert(schema.creativeProjects)
    .values({
      projectId: id,
      document: JSON.stringify(createCreativeDocument()),
      revision: 1,
      updatedAt: now,
    })
    .run()
  // One second of valid mono PCM, decoded and converted by the real FFmpeg path.
  const wave = Buffer.alloc(44 + 16000)
  wave.write('RIFF')
  wave.writeUInt32LE(wave.length - 8, 4)
  wave.write('WAVEfmt ', 8)
  wave.writeUInt32LE(16, 16)
  wave.writeUInt16LE(1, 20)
  wave.writeUInt16LE(1, 22)
  wave.writeUInt32LE(8000, 24)
  wave.writeUInt32LE(16000, 28)
  wave.writeUInt16LE(2, 32)
  wave.writeUInt16LE(16, 34)
  wave.write('data', 36)
  wave.writeUInt32LE(16000, 40)
  for (let i = 0; i < 8000; i++)
    wave.writeInt16LE(Math.round(Math.sin((i * Math.PI * 2 * 440) / 8000) * 4000), 44 + i * 2)
  const folder = path.join(dir, 'static', 'creative', String(id))
  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(path.join(folder, 'source.wav'), wave)
  return {
    id,
    input: {
      revision: 1,
      toolId: 'transcriber',
      args: { sourceUrl: `/static/creative/${id}/source.wav` },
      configId,
    },
  }
}
after(async () => {
  providerDependencies.fetch = originalFetch
  for (const service of services) service.dispose()
  await fs.rm(dir, { recursive: true, force: true })
})
test('transcription network uncertainty blocks ordinary resubmission before another billable POST', async () => {
  const p = await project(),
    service = createToolboxService()
  services.push(service)
  let posts = 0
  providerDependencies.fetch = async () => {
    posts++
    throw new Error('connection lost after acceptance')
  }
  const job = await service.start(p.id, p.input)
  await service.idle(job.id)
  assert.equal(listToolboxJobs(p.id)[0].status, 'uncertain')
  assert.throws(() => service.resume(p.id, job.id), /提交结果未知/)
  assert.equal(posts, 1)
})
test('a received transcription is reused after local output processing fails', async () => {
  const p = await project()
  let first = true,
    posts = 0
  const service = createToolboxService(async (ctx) => {
    const result = await executeTool(ctx)
    if (first) {
      first = false
      throw new Error('temporary local output failure')
    }
    return result
  })
  services.push(service)
  providerDependencies.fetch = async (url, init) => {
    posts++
    assert.equal(String(url), 'https://api.openai.com/v1/audio/transcriptions')
    assert.equal(init?.method, 'POST')
    assert.ok(init?.body instanceof FormData)
    return Response.json({ text: '测试字幕', segments: [{ start: 0, end: 0.8, text: '测试字幕' }] })
  }
  const job = await service.start(p.id, p.input)
  await service.idle(job.id)
  assert.equal(listToolboxJobs(p.id)[0].status, 'failed')
  service.resume(p.id, job.id)
  await service.idle(job.id)
  const finished = listToolboxJobs(p.id)[0]
  assert.equal(finished.status, 'completed')
  assert.equal(posts, 1)
  const file = finished.result.files[0]
  const srt = await fs.readFile(path.join(dir, 'static', file.url.slice('/static/'.length)), 'utf8')
  assert.match(srt, /00:00:00,000 --> 00:00:00,800/)
  assert.match(srt, /测试字幕/)
})
test('a definitively rejected transcription may retry without an unknown-submission acknowledgement', async () => {
  const p = await project(),
    service = createToolboxService()
  services.push(service)
  let posts = 0
  providerDependencies.fetch = async () =>
    ++posts === 1
      ? new Response('', { status: 429 })
      : Response.json({ segments: [{ start: 0, end: 0.8, text: '恢复成功' }] })
  const job = await service.start(p.id, p.input)
  await service.idle(job.id)
  assert.equal(listToolboxJobs(p.id)[0].status, 'failed')
  service.resume(p.id, job.id)
  await service.idle(job.id)
  assert.equal(listToolboxJobs(p.id)[0].status, 'completed')
  assert.equal(posts, 2)
})
