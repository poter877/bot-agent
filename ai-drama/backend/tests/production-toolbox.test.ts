import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'production-toolbox-'))
process.env.SQLITE_PATH = path.join(dir, 'test.sqlite')
process.env.STORAGE_PATH = path.join(dir, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema, getInsertId } = await import('../src/db/index.js')
const { createCreativeDocument } = await import('../src/services/creative-model.js')
const { getCreativeProject, saveCreativeProject } = await import('../src/services/creative-projects.js')
const { createToolboxService, listToolboxJobs, applyToolboxOutput } = await import(
  '../src/services/production-tools/jobs.js'
)
const { toolboxCatalog, getToolDefinition } = await import('../src/services/production-tools/catalog.js')
const { createCreativeRoutes } = await import('../src/routes/creative.js')
await fs.mkdir(path.join(dir, 'static'), { recursive: true })
const services: ReturnType<typeof createToolboxService>[] = []
function create() {
  const now = new Date().toISOString(),
    id = getInsertId(
      db
        .insert(schema.dramas)
        .values({
          title: '工具测试',
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
  return getCreativeProject(id)
}
function service(executor: Parameters<typeof createToolboxService>[0]) {
  const s = createToolboxService(executor)
  services.push(s)
  return s
}
async function output(ctx: any) {
  const file = path.join(ctx.outputDir, 'output.png')
  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#336699' } })
    .png()
    .toFile(file)
  return { summary: '真实图片', files: [{ path: file, name: 'output.png', kind: 'image' as const }] }
}
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { resolve, promise }
}
after(async () => {
  for (const s of services) s.dispose()
  await fs.rm(dir, { recursive: true, force: true })
})

test('full inventory resolves, dependencies are explicit, retired APIs are identified', async () => {
  const c = await toolboxCatalog()
  assert.equal(c.referenceCount, 153)
  assert.equal(new Set(c.tools.map((t) => t.id)).size, 153)
  assert.deepEqual(
    c.tools.filter((t) => !t.implemented).map((t) => t.id),
    [],
  )
  for (const t of c.tools) {
    assert.ok(t.inputs.length, t.id)
    assert.ok(t.category)
  }
  assert.equal(c.tools.find((t) => t.id === 'comfyui_image')!.available, false)
  assert.match(c.tools.find((t) => t.id === 'sora_video')!.name, /接口已停用/)
})
test('duplicate submission executes once and never changes the document automatically', async () => {
  const p = create(),
    gate = deferred()
  let calls = 0
  const s = service(async (ctx) => {
    calls++
    await gate.promise
    return output(ctx)
  })
  const input = { revision: 1, toolId: 'showcase_card', args: { title: '测试' } }
  const a = await s.start(p.id, input),
    b = await s.start(p.id, input)
  assert.equal(a.id, b.id)
  gate.resolve()
  await s.idle(a.id)
  assert.equal(calls, 1)
  assert.equal(listToolboxJobs(p.id)[0].status, 'completed')
  assert.equal(getCreativeProject(p.id).revision, 1)
})
test('cancelled work cannot publish a late completion', async () => {
  const p = create(),
    gate = deferred(),
    entered = deferred()
  const s = service(async (ctx) => {
    entered.resolve()
    await gate.promise
    return output(ctx)
  })
  const j = await s.start(p.id, { revision: 1, toolId: 'showcase_card', args: { title: '取消' } })
  await entered.promise
  s.cancel(p.id, j.id)
  gate.resolve()
  await s.idle(j.id)
  assert.equal(listToolboxJobs(p.id)[0].status, 'cancelled')
  assert.deepEqual(listToolboxJobs(p.id)[0].result, {})
})
test('unknown submission requires explicit acknowledgement before resubmitting', async () => {
  const p = create()
  let calls = 0
  const s = service(async (ctx) => {
    calls++
    if (calls === 1) {
      ctx.checkpoint({ submissionStarted: true })
      throw new Error('服务连接中断')
    }
    assert.equal(ctx.state.submissionStarted, false)
    return output(ctx)
  })
  const j = await s.start(p.id, { revision: 1, toolId: 'showcase_card', args: { title: '未知' } })
  await s.idle(j.id)
  assert.equal(listToolboxJobs(p.id)[0].status, 'uncertain')
  assert.throws(() => s.resume(p.id, j.id), /提交结果未知/)
  s.resume(p.id, j.id, undefined, true)
  await s.idle(j.id)
  assert.equal(calls, 2)
  assert.equal(listToolboxJobs(p.id)[0].status, 'completed')
})
test('remote recovery retains its ID and refuses another identifier', async () => {
  const p = create()
  let calls = 0
  const s = service(async (ctx) => {
    calls++
    if (calls === 1) {
      ctx.checkpoint({ remoteId: 'remote-one', submissionStarted: true })
      throw new Error('服务连接中断')
    }
    assert.equal(ctx.state.remoteId, 'remote-one')
    return output(ctx)
  })
  const j = await s.start(p.id, { revision: 1, toolId: 'showcase_card', args: { title: '恢复' } })
  await s.idle(j.id)
  assert.throws(() => s.resume(p.id, j.id, 'other-id'), /不能更换/)
  s.resume(p.id, j.id)
  await s.idle(j.id)
  assert.equal(listToolboxJobs(p.id)[0].status, 'completed')
})
test('import enforces ownership and CAS, preserves attribution and deduplicates', async () => {
  const p = create(),
    other = create(),
    s = service(async (ctx) => ({ ...(await output(ctx)), data: { attribution: '作者与许可' } }))
  const j = await s.start(p.id, { revision: 1, toolId: 'showcase_card', args: { title: '导入' } })
  await s.idle(j.id)
  const current = saveCreativeProject(p.id, { ...p, title: '并发编辑' })
  await assert.rejects(applyToolboxOutput(p.id, j.id, { revision: 1 }), /修改|更新/)
  await assert.rejects(applyToolboxOutput(other.id, j.id, { revision: 1 }), /不存在/)
  const imported = await applyToolboxOutput(p.id, j.id, { revision: current.revision })
  assert.equal(imported.title, '并发编辑')
  assert.equal(imported.production.sources.length, 1)
  assert.equal(imported.production.sources[0].attribution, '作者与许可')
  assert.equal(
    (await applyToolboxOutput(p.id, j.id, { revision: imported.revision })).revision,
    imported.revision,
  )
})
test('output symlinks cannot escape the job directory', async () => {
  const p = create(),
    outside = path.join(dir, 'private.png')
  await sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } })
    .png()
    .toFile(outside)
  const s = service(async (ctx) => {
    const file = path.join(ctx.outputDir, 'escape.png')
    await fs.symlink(outside, file)
    return { summary: '越界', files: [{ path: file, name: 'escape.png', kind: 'image' }] }
  })
  const j = await s.start(p.id, { revision: 1, toolId: 'showcase_card', args: { title: '边界' } })
  await s.idle(j.id)
  assert.equal(listToolboxJobs(p.id)[0].status, 'failed')
})
test('credentials are rejected in tool parameters', async () => {
  const p = create(),
    s = service(output)
  await assert.rejects(
    s.start(p.id, {
      revision: 1,
      toolId: 'showcase_card',
      args: { title: '密钥', parameters: { api_key: 'secret' } },
    }),
    /密钥/,
  )
  assert.equal(listToolboxJobs(p.id).length, 0)
})
test('interrupted submission is retained without automatic execution', () => {
  const p = create()
  let calls = 0
  const s = service(async (ctx) => {
      calls++
      return output(ctx)
    }),
    now = new Date().toISOString()
  db.insert(schema.productionToolJobs)
    .values({
      projectId: p.id,
      toolId: 'showcase_card',
      fingerprint: 'interrupted',
      revision: 1,
      input: '{}',
      state: '{"submissionStarted":true}',
      status: 'running',
      createdAt: now,
      updatedAt: now,
    })
    .run()
  s.recover()
  assert.equal(listToolboxJobs(p.id)[0].status, 'uncertain')
  assert.equal(calls, 0)
})
test('upload accepts structured input and rejects executable SVG and invalid projects', async () => {
  const p = create(),
    app = createCreativeRoutes()
  async function upload(name: string, bytes: string, id = p.id) {
    const form = new FormData()
    form.set('file', new Blob([bytes]), name)
    return app.request(`/${id}/toolbox/upload`, { method: 'POST', body: form })
  }
  assert.equal((await upload('good.json', '{"actions":[]}')).status, 200)
  assert.equal(
    (await upload('bad.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))
      .status,
    400,
  )
  assert.equal((await upload('bad.json', 'not json')).status, 400)
  assert.equal((await upload('missing.txt', 'test', 999999)).status, 404)
})
test('default changes do not change the pinned account, and job history redacts secrets', async () => {
  const p = create(),
    now = new Date().toISOString(),
    a = getInsertId(
      db
        .insert(schema.aiServiceConfigs)
        .values({
          serviceType: 'image',
          provider: 'openai',
          name: 'A',
          baseUrl: 'https://example.invalid',
          apiKey: 'account-a-secret',
          model: '["gpt-image-2"]',
          priority: 3,
          createdAt: now,
          updatedAt: now,
        })
        .run(),
    )
  let fail = true
  const s = service(async (ctx) => {
    assert.equal(ctx.config?.id, a)
    assert.equal(ctx.config?.apiKey, 'account-a-secret')
    if (fail) {
      ctx.checkpoint({ remoteId: 'keep-me', submissionStarted: true })
      throw new Error('服务查询失败')
    }
    return output(ctx)
  })
  const j = await s.start(p.id, { revision: 1, toolId: 'image_selector', args: { prompt: '画面' } })
  await s.idle(j.id)
  db.insert(schema.aiServiceConfigs)
    .values({
      serviceType: 'image',
      provider: 'openai',
      name: 'B',
      baseUrl: 'https://example.invalid',
      apiKey: 'account-b-secret',
      model: '["gpt-image-2"]',
      priority: 99,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  fail = false
  s.resume(p.id, j.id)
  await s.idle(j.id)
  assert.equal(listToolboxJobs(p.id)[0].status, 'completed')
  assert.ok(!JSON.stringify(listToolboxJobs(p.id)).includes('secret'))
})

test('shared selectors use the actual keyless provider for availability and execution', async () => {
  const p = create(),
    now = new Date().toISOString()
  const configId = getInsertId(
    db
      .insert(schema.aiServiceConfigs)
      .values({
        serviceType: 'image',
        provider: 'comfyui',
        name: '本地 ComfyUI',
        baseUrl: 'http://127.0.0.1:8188',
        apiKey: '',
        model: '["api-workflow"]',
        priority: 10000,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .run(),
  )
  try {
    assert.equal(getToolDefinition('image_selector').available, true)
    assert.equal(getToolDefinition('image_gen').available, true)
    const s = service(async (ctx) => {
      assert.equal(ctx.config?.id, configId)
      assert.equal(ctx.config?.provider, 'comfyui')
      assert.equal(ctx.config?.apiKey, '')
      return output(ctx)
    })
    for (const toolId of ['image_selector', 'image_gen']) {
      const job = await s.start(p.id, { revision: 1, toolId, args: { prompt: '本地画面' } })
      await s.idle(job.id)
      assert.equal(listToolboxJobs(p.id).find((item) => item.id === job.id)?.status, 'completed')
    }
  } finally {
    db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, configId)).run()
  }
})

test('cached synchronous responses survive failure, restart and legacy uncertain recovery without resubmission', async () => {
  for (const key of ['syncResult', 'searchResult', 'transcriptionResult']) {
    const p = create(),
      cached = { value: `cached-${key}` }
    let submissions = 0
    const s = service(async (ctx) => {
      if (!ctx.state[key]) {
        submissions++
        ctx.checkpoint({ submissionStarted: true, [key]: cached })
        throw new Error('服务产物下载临时失败')
      }
      assert.deepEqual(ctx.state[key], cached)
      return output(ctx)
    })
    const job = await s.start(p.id, { revision: 1, toolId: 'showcase_card', args: { title: key } })
    await s.idle(job.id)
    assert.equal(listToolboxJobs(p.id)[0].status, 'failed')
    db.update(schema.productionToolJobs)
      .set({ status: 'running' })
      .where(eq(schema.productionToolJobs.id, job.id))
      .run()
    s.recover()
    assert.equal(listToolboxJobs(p.id)[0].status, 'failed')
    // Old versions classified this exact state as uncertain; it must still be recoverable.
    db.update(schema.productionToolJobs)
      .set({ status: 'uncertain' })
      .where(eq(schema.productionToolJobs.id, job.id))
      .run()
    s.resume(p.id, job.id)
    await s.idle(job.id)
    assert.equal(listToolboxJobs(p.id)[0].status, 'completed')
    assert.equal(submissions, 1)
  }
})

test('JSON caption import validates cues and VTT minute timestamps convert to SRT', async () => {
  const p = create(),
    uploads = path.join(dir, 'static', 'uploads')
  await fs.mkdir(uploads, { recursive: true })
  const wav = Buffer.alloc(44 + 6000)
  wav.write('RIFF')
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(1000, 24)
  wav.writeUInt32LE(2000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(6000, 40)
  await fs.writeFile(path.join(uploads, 'caption-source.wav'), wav)
  const source = {
    id: randomUUID(),
    name: '字幕原声',
    kind: 'audio' as const,
    url: '/static/uploads/caption-source.wav',
    duration: 3,
    coverUrl: null,
    transcript: '',
    attribution: '',
  }
  saveCreativeProject(p.id, { ...p, production: { ...p.production, sources: [source] } }, source)
  async function apply(name: string, body: string) {
    const s = service(async (ctx) => {
      const file = path.join(ctx.outputDir, name)
      await fs.writeFile(file, body)
      return { summary: '字幕', files: [{ path: file, name, kind: 'subtitle' }] }
    })
    const current = getCreativeProject(p.id)
    const job = await s.start(p.id, {
      revision: current.revision,
      toolId: 'showcase_card',
      args: { title: name + body },
    })
    await s.idle(job.id)
    return applyToolboxOutput(p.id, job.id, {
      revision: getCreativeProject(p.id).revision,
      sourceId: source.id,
    })
  }
  const json = await apply('captions.json', JSON.stringify([{ start: 0.5, end: 1.5, text: 'JSON 字幕' }]))
  assert.match(json.production.sources[0].transcript, /00:00:00,500 --> 00:00:01,500/)
  assert.match(json.production.sources[0].transcript, /JSON 字幕/)
  const vtt = await apply('captions.vtt', 'WEBVTT\n\n00:00.750 --> 00:02.500 align:middle\nVTT 字幕\n')
  assert.match(vtt.production.sources[0].transcript, /00:00:00,750 --> 00:00:02,500/)
  for (const invalid of [
    [{ start: '0', end: 1, text: '字符串时间' }],
    [{ start: -1, end: 1, text: '负数' }],
    [{ start: 1, end: 0.5, text: '倒序' }],
    [
      { start: 0, end: 1, text: 'a' },
      { start: 0.5, end: 2, text: '重叠' },
    ],
    [{ start: 0, end: 1, text: '未知字段', command: 'execute' }],
    [{ start: 0, end: 4, text: '超出素材时长' }],
  ]) {
    const previous = getCreativeProject(p.id)
    await assert.rejects(apply('invalid.json', JSON.stringify(invalid)), /JSON|字幕|时码/)
    assert.equal(getCreativeProject(p.id).revision, previous.revision)
    assert.equal(
      getCreativeProject(p.id).production.sources[0].transcript,
      previous.production.sources[0].transcript,
    )
  }
})
