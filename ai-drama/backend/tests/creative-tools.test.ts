import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { eq } from 'drizzle-orm'
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-tools-'))
process.env.SQLITE_PATH = path.join(directory, 'test.sqlite')
process.env.HUOBAO_DATA_DIR = directory
process.env.STORAGE_PATH = path.join(directory, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema, getInsertId } = await import('../src/db/index.js')
const { createCreativeDocument, CreativeError } = await import('../src/services/creative-model.js')
const { getCreativeProject, saveCreativeProject, approveCreativeProject } = await import(
  '../src/services/creative-projects.js'
)
const {
  createToolService,
  toolDependencies,
  getToolJob,
  listToolJobs,
  uploadCreativeModel,
  applyLipSync,
  importStockCandidate,
  listCreativeModels,
} = await import('../src/services/creative-tools/jobs.js')
const { publicToolSettings, saveToolSettings } = await import('../src/services/creative-tools/settings.js')
const { inspectGlb } = await import('../src/services/creative-tools/files.js')
const { checkRemoteUrl, isPublicIPv4, ProviderRejected } = await import(
  '../src/services/creative-tools/network.js'
)
const { executeExtensions, extensionTools } = await import('../src/services/creative-pipeline/extensions.js')
const { pipelineDefinitions } = await import('../src/services/creative-pipeline/definitions.js')
const { createStageExecutor, pipelineTools } = await import('../src/services/creative-pipeline/executor.js')
const { ffmpegPath } = await import('../src/utils/ffmpeg.js')
type Deps = typeof toolDependencies
const services: ReturnType<typeof createToolService>[] = []
function service(deps: Partial<Deps>) {
  const s = createToolService({ ...toolDependencies, ...deps }, 100000)
  services.push(s)
  return s
}
function create() {
  const doc = createCreativeDocument('character_animation')
  doc.brief.idea = '海洋生态'
  doc.shots = [
    {
      id: 'speaker',
      title: '讲解',
      duration: 2,
      narration: '测试台词',
      caption: '',
      visualPrompt: '人物',
      mediaType: 'video',
      videoUrl: '/static/uploads/source.mp4',
      imageUrl: null,
      audioUrl: '/static/uploads/voice.wav',
      audioTrimStart: 0,
      trimStart: 0,
      originalVolume: 1,
      imageTaskId: null,
      videoTaskId: null,
    },
  ]
  const now = new Date().toISOString()
  const id = getInsertId(
    db
      .insert(schema.dramas)
      .values({
        title: '制作测试',
        projectType: 'creative',
        creativeCategory: 'character_animation',
        createdAt: now,
        updatedAt: now,
      })
      .run(),
  )
  db.insert(schema.creativeProjects)
    .values({ projectId: id, document: JSON.stringify(doc), revision: 1, updatedAt: now })
    .run()
  return getCreativeProject(id)
}
function context(project: ReturnType<typeof create>, stageId: string) {
  const definition = pipelineDefinitions.find((p) => p.category === project.category)!
  return {
    project,
    definition,
    stage: definition.stages.find((s) => s.id === stageId)!,
    artifacts: {},
    previous: null,
    retry: false,
    checkpoint: () => {},
  }
}
// An embedded triangle, with real joint and weight accessors in the rig fixture.
function glb(rig = false, external = false) {
  const positions = Buffer.alloc(36)
  ;[0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((n, i) => positions.writeFloatLE(n, i * 4))
  const joints = Buffer.alloc(12),
    weights = Buffer.alloc(48)
  ;[0, 4, 8].forEach((i) => weights.writeFloatLE(1, i * 4))
  const bin = rig ? Buffer.concat([positions, joints, weights]) : positions
  const model = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: rig ? [0, 1] : [0] }],
    nodes: rig ? [{ mesh: 0, skin: 0 }, { name: 'root' }] : [{ mesh: 0 }],
    buffers: [{ byteLength: bin.length, ...(external ? { uri: 'https://evil.invalid/secret' } : {}) }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      ...(rig
        ? [
            { buffer: 0, byteOffset: 36, byteLength: 12 },
            { buffer: 0, byteOffset: 48, byteLength: 48 },
          ]
        : []),
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      ...(rig
        ? [
            { bufferView: 1, componentType: 5121, count: 3, type: 'VEC4' },
            { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' },
          ]
        : []),
    ],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0, ...(rig ? { JOINTS_0: 1, WEIGHTS_0: 2 } : {}) } }] },
    ],
    ...(rig ? { skins: [{ joints: [1] }] } : {}),
  }
  const raw = Buffer.from(JSON.stringify(model)),
    json = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 0x20)
  raw.copy(json)
  const out = Buffer.alloc(28 + json.length + bin.length)
  out.write('glTF')
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(out.length, 8)
  out.writeUInt32LE(json.length, 12)
  out.writeUInt32LE(0x4e4f534a, 16)
  json.copy(out, 20)
  out.writeUInt32LE(bin.length, 20 + json.length)
  out.writeUInt32LE(0x004e4942, 24 + json.length)
  bin.copy(out, 28 + json.length)
  return out
}
before(async () => {
  await fs.mkdir(path.join(directory, 'static/uploads'), { recursive: true })
  execFileSync(ffmpegPath!, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=64x64:r=30',
    '-t',
    '2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    path.join(directory, 'static/uploads/source.mp4'),
  ])
  execFileSync(ffmpegPath!, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440',
    '-t',
    '2',
    '-c:a',
    'pcm_s16le',
    path.join(directory, 'static/uploads/voice.wav'),
  ])
  for (const provider of ['sync', 'meshy', 'tavily', 'pexels'] as const)
    saveToolSettings(provider, { enabled: true, apiKey: `secret-${provider}` })
})
after(async () => {
  services.forEach((s) => s.dispose())
  db.$client.close()
  await fs.rm(directory, { recursive: true, force: true })
})

test('settings redact secrets; blank preserves and explicit clear disables', () => {
  assert.ok(!JSON.stringify(publicToolSettings()).includes('secret'))
  saveToolSettings('sync', { enabled: true, apiKey: '' })
  assert.equal(publicToolSettings().find((s) => s.provider === 'sync')?.configured, true)
  saveToolSettings('sync', { enabled: false, clearKey: true })
  assert.throws(() => saveToolSettings('sync', { enabled: true }), /API Key/)
  saveToolSettings('sync', { enabled: true, apiKey: 'secret-sync' })
})
test('remote download rejects private IPs, unsafe domains, credentials and non-HTTPS', () => {
  for (const url of [
    'http://images.pexels.com/x',
    'https://pexels.com.evil.test/x',
    'https://user:pass@pexels.com/x',
    'https://127.0.0.1/x',
    'https://pexels.com:123/x',
  ])
    assert.throws(() => checkRemoteUrl(url, ['pexels.com']))
  assert.equal(checkRemoteUrl('https://videos.pexels.com/x', ['pexels.com']).hostname, 'videos.pexels.com')
  for (const ip of [
    '127.0.0.1',
    '10.2.3.4',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.1.1',
    '100.64.0.1',
    '224.1.1.1',
    '999.1.1.1',
  ])
    assert.equal(isPublicIPv4(ip), false, ip)
  assert.equal(isPublicIPv4('8.8.8.8'), true)
})
test('GLB validation checks geometry, embedded resources, rig and ownership', async () => {
  const p = create(),
    other = create()
  assert.deepEqual(inspectGlb(glb()), { meshes: 1, joints: 0, animations: 0 })
  assert.throws(() => inspectGlb(Buffer.from('fake.glb')), /GLB/)
  assert.throws(() => inspectGlb(glb(false, true)), /外部资源/)
  assert.throws(() => inspectGlb(glb(), true), /骨骼/)
  assert.equal(inspectGlb(glb(true), true).joints, 1)
  const model = await uploadCreativeModel(p.id, '角色.glb', glb())
  assert.equal(listCreativeModels(p.id)[0].id, model.id)
  await assert.rejects(service({}).start(other.id, 1, 'rigging', { modelId: model.id }), /该项目/)
})
function syncDeps(onSubmit = () => {}): Partial<Deps> {
  return {
    json: async (url, key, body, headers) => {
      assert.equal(key, 'secret-sync')
      if (url.endsWith('/assets/upload'))
        return { uploadUrl: 'https://uploads.sync.so/x', url: 'https://assets.sync.so/x' }
      if (url.endsWith('/assets')) return { id: `asset-${(body as { type: string }).type}` }
      if (url.endsWith('/generate')) {
        onSubmit()
        assert.ok(headers?.['Idempotency-Key'])
        assert.deepEqual((body as { input: unknown }).input, [
          { type: 'video', assetId: 'asset-VIDEO' },
          { type: 'audio', assetId: 'asset-AUDIO' },
        ])
        return { id: 'sync-1' }
      }
      return { status: 'COMPLETED', outputUrl: 'https://assets.sync.so/output.mp4' }
    },
    bytes: async (_url, _hosts, _limit, options) => {
      if (options?.method === 'PUT') {
        assert.ok(options.body!.length > 100)
        return Buffer.alloc(0)
      }
      return fs.readFile(path.join(directory, 'static/uploads/source.mp4'))
    },
  }
}
test('Sync uploads actual media once, probes output, applies revision safely and pipeline does not resync', async () => {
  const p = create()
  approveCreativeProject(p.id, 1)
  let submit = 0
  const s = service(syncDeps(() => submit++))
  const j = await s.start(p.id, 1, 'lipsync', { shotId: 'speaker' })
  await s.idle(j.id)
  assert.equal(getToolJob(p.id, j.id).status, 'completed', getToolJob(p.id, j.id).error ?? '')
  assert.equal((await s.start(p.id, 1, 'lipsync', { shotId: 'speaker' })).id, j.id)
  assert.equal(submit, 1)
  const saved = await applyLipSync(p.id, j.id, 1, true)
  assert.equal(saved.revision, 2)
  assert.equal(saved.approvedRevision, 2)
  assert.equal(saved.shots[0].originalVolume, 0)
  assert.match(saved.shots[0].videoUrl!, /tool-/)
  assert.equal((await applyLipSync(p.id, j.id, 2)).revision, 2)
  await assert.rejects(applyLipSync(p.id, j.id, 1), /修改|变化/)
  const ctx = context(saved, 'assets')
  ctx.project.production.fields.lipSyncMode = 'sync'
  assert.equal(
    await executeExtensions(ctx, {
      ...extensionTools,
      start: async () => {
        throw new Error('duplicate')
      },
    }),
    null,
  )
})
test('lip-sync cannot overwrite edited input', async () => {
  const p = create(),
    s = service(syncDeps())
  const j = await s.start(p.id, 1, 'lipsync', { shotId: 'speaker' })
  await s.idle(j.id)
  const saved = saveCreativeProject(p.id, { ...p, shots: p.shots.map((s) => ({ ...s, duration: 1 })) })
  await assert.rejects(applyLipSync(p.id, j.id, saved.revision), /输入已变化/)
})
test('Meshy submits embedded GLB and retains rigged GLB and FBX', async () => {
  const p = create(),
    model = await uploadCreativeModel(p.id, 'human.glb', glb())
  let submitted = 0
  const s = service({
    json: async (_url, _key, body) => {
      if (body) {
        submitted++
        assert.match((body as { model_url: string }).model_url, /^data:application\/octet-stream;base64,/)
        return { result: 'mesh-task' }
      }
      return {
        status: 'SUCCEEDED',
        result: {
          rigged_character_glb_url: 'https://assets.meshy.ai/rig.glb',
          rigged_character_fbx_url: 'https://assets.meshy.ai/rig.fbx',
        },
      }
    },
    bytes: async (url) =>
      url.endsWith('.fbx') ? Buffer.from('Kaydara FBX Binary  \0                    ') : glb(true),
  })
  const j = await s.start(p.id, 1, 'rigging', { modelId: model.id, height: 1.8 })
  await s.idle(j.id)
  const done = getToolJob(p.id, j.id)
  assert.equal(done.status, 'completed', done.error ?? '')
  assert.equal(done.result.files?.length, 2)
  assert.equal(done.result.files?.[0].metadata?.joints, 1)
  await s.start(p.id, 1, 'rigging', { modelId: model.id, height: 1.8 })
  assert.equal(submitted, 1)
})
test('unknown submission blocks retries and remote-ID recovery never resubmits', async () => {
  const p = create(),
    model = await uploadCreativeModel(p.id, 'human.glb', glb())
  let posts = 0
  const s = service({
    json: async (_url, _key, body) => {
      if (body) {
        posts++
        throw new Error('lost after acceptance')
      }
      return { status: 'SUCCEEDED', result: { rigged_character_glb_url: 'https://meshy.ai/rig.glb' } }
    },
    bytes: async () => glb(true),
  })
  const j = await s.start(p.id, 1, 'rigging', { modelId: model.id })
  await s.idle(j.id)
  assert.equal(getToolJob(p.id, j.id).status, 'uncertain')
  assert.throws(() => s.resume(p.id, j.id), /避免重复计费/)
  assert.equal((await s.start(p.id, 1, 'rigging', { modelId: model.id }, true)).id, j.id)
  assert.equal(posts, 1)
  s.resume(p.id, j.id, 'recovered-id')
  await s.idle(j.id)
  assert.equal(posts, 1)
  assert.equal(getToolJob(p.id, j.id).status, 'completed')
})
test('definitive rejection allows explicit new submission', async () => {
  const p = create(),
    model = await uploadCreativeModel(p.id, 'human.glb', glb())
  const s = service({
    json: async () => {
      throw new ProviderRejected('制作服务返回 400', 422)
    },
  })
  const j = await s.start(p.id, 1, 'rigging', { modelId: model.id })
  await s.idle(j.id)
  assert.equal(getToolJob(p.id, j.id).status, 'failed')
  const next = await s.start(p.id, 1, 'rigging', { modelId: model.id }, true)
  assert.notEqual(next.id, j.id)
  await s.idle(next.id)
})
test('restart polls existing remote task and rejects unrigged output', async () => {
  const p = create(),
    model = await uploadCreativeModel(p.id, 'human.glb', glb())
  const first = service({
    json: async (_u, _k, body) => (body ? { result: 'existing' } : { status: 'IN_PROGRESS', progress: 30 }),
  })
  const j = await first.start(p.id, 1, 'rigging', { modelId: model.id })
  await first.idle(j.id)
  first.dispose()
  const stored = db.select().from(schema.creativeToolJobs).where(eq(schema.creativeToolJobs.id, j.id)).get()!
  const pinned = JSON.parse(stored.input).configId
  assert.ok(pinned)
  const original = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, pinned)).get()!
  const alternative = getInsertId(db.insert(schema.aiServiceConfigs).values({ ...original, id: undefined,
    name: 'Other Meshy account', apiKey: 'other-meshy-secret', priority: 99 }).run())
  let posts = 0
  const second = service({
    json: async (_u, key, body) => {
      assert.equal(key, original.apiKey)
      if (body) posts++
      return { status: 'SUCCEEDED', result: { rigged_character_glb_url: 'https://meshy.ai/rig.glb' } }
    },
    bytes: async () => glb(),
  })
  second.recover()
  await second.idle(j.id)
  assert.equal(posts, 0)
  assert.equal(getToolJob(p.id, j.id).status, 'failed')
  assert.match(getToolJob(p.id, j.id).error!, /骨骼/)
  db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, alternative)).run()
})
test('Pexels imports real media with attribution, deduplicates and checks revision', async () => {
  const p = create()
  const deps: Deps = {
    ...toolDependencies,
    json: async (url) => {
      assert.match(url, /v1\/videos\/search/)
      return {
        videos: [
          {
            id: 7,
            url: 'https://www.pexels.com/video/7',
            image: 'https://images.pexels.com/7.jpg',
            duration: 2,
            user: { name: 'Artist', url: 'https://www.pexels.com/@artist' },
            video_files: [
              { link: 'https://videos.pexels.com/7.mp4', file_type: 'video/mp4', width: 64, height: 64 },
            ],
          },
        ],
      }
    },
    bytes: async () => fs.readFile(path.join(directory, 'static/uploads/source.mp4')),
  }
  const s = service(deps),
    j = await s.start(p.id, 1, 'stock', { query: 'ocean' })
  await s.idle(j.id)
  const saved = await importStockCandidate(p.id, j.id, '7', 1, deps)
  assert.equal(saved.production.sources.length, 1)
  assert.match(saved.production.sources[0].attribution, /Artist · Pexels/)
  assert.match(saved.production.sources[0].attribution, /license/)
  assert.equal((await importStockCandidate(p.id, j.id, '7', 2, deps)).revision, 2)
  await assert.rejects(importStockCandidate(p.id, j.id, '7', 1, deps), /变化|修改/)
  await assert.rejects(importStockCandidate(p.id, j.id, 'https://localhost', 2, deps), /不存在/)
})
test('research evidence enters the narrative and retained source list', async () => {
  const p = create()
  p.production.fields.researchMode = 'tavily'
  const saved = saveCreativeProject(p.id, p)
  const s = service({
    json: async () => ({
      results: [{ title: 'Ocean evidence', url: 'https://example.org/science', content: 'Verified excerpt' }],
    }),
  })
  const start = async (...args: Parameters<typeof s.start>) => {
    const j = await s.start(...args)
    await s.idle(j.id)
    return getToolJob(args[0], j.id)
  }
  const executor = createStageExecutor({
    ...pipelineTools,
    extensions: { ...extensionTools, start },
    narrative: async (ctx) => {
      assert.match(JSON.stringify(ctx.artifacts), /Verified excerpt/)
      return { summary: 'Research', content: 'Evidence with citations', checks: [] }
    },
  })
  const output = await executor(context(saved, 'research'))
  assert.equal((output.artifact.data?.articles as unknown[]).length, 1)
})
test('rig stage returns actual bound model rather than a fabricated narrative', async () => {
  const p = create(),
    model = await uploadCreativeModel(p.id, 'human.glb', glb())
  p.production.fields = { rigMode: 'meshy', rigModelId: String(model.id) }
  const saved = saveCreativeProject(p.id, p)
  const s = service({
    json: async (_u, _k, body) =>
      body
        ? { result: 'rig' }
        : { status: 'SUCCEEDED', result: { rigged_character_glb_url: 'https://meshy.ai/rig.glb' } },
    bytes: async () => glb(true),
  })
  const start = async (...args: Parameters<typeof s.start>) => {
    const j = await s.start(...args)
    await s.idle(j.id)
    return getToolJob(args[0], j.id)
  }
  const output = await executeExtensions(context(saved, 'rig_plan'), { ...extensionTools, start })
  assert.ok(output?.artifact.data?.files)
  assert.equal(output?.waiting, undefined)
})
test('deleted project cannot expose jobs or models', () => {
  const p = create()
  db.update(schema.dramas)
    .set({ deletedAt: new Date().toISOString() })
    .where(eq(schema.dramas.id, p.id))
    .run()
  assert.throws(() => listToolJobs(p.id), CreativeError)
  assert.throws(() => listCreativeModels(p.id), CreativeError)
})

test('portrait sync uses the selected image and ignores an old inactive video slot', async () => {
  const sharp = (await import('sharp')).default
  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#5577aa' } })
    .png()
    .toFile(path.join(directory, 'static/uploads/portrait.png'))
  const p = create()
  p.shots[0].mediaType = 'image'
  p.shots[0].imageUrl = '/static/uploads/portrait.png'
  const saved = saveCreativeProject(p.id, p)
  const deps = syncDeps()
  const original = deps.json!
  deps.json = async (url, key, body, headers) => {
    if (url.endsWith('/generate')) {
      assert.equal((body as { model: string }).model, 'sync-3')
      assert.equal((body as { input: { type: string }[] }).input[0].type, 'image')
      return { id: 'portrait' }
    }
    return original(url, key, body, headers)
  }
  const s = service(deps)
  await assert.rejects(s.start(p.id, saved.revision, 'lipsync', { shotId: 'speaker' }), /sync-3/)
  saveToolSettings('sync', { enabled: true, model: 'sync-3' })
  const j = await s.start(p.id, saved.revision, 'lipsync', { shotId: 'speaker' })
  await s.idle(j.id)
  assert.equal(getToolJob(p.id, j.id).status, 'completed')
  const applied = await applyLipSync(p.id, j.id, saved.revision)
  assert.equal(applied.shots[0].mediaType, 'video')
  assert.notEqual(applied.shots[0].videoUrl, p.shots[0].videoUrl)
  saveToolSettings('sync', { enabled: true, model: 'lipsync-2' })
})

test('automatic stock imports once, advances the revision, and gives the next stage real sources', async () => {
  const p = create()
  p.production.fields = { stockMode: 'pexels', stockQuery: 'ocean', stockCount: '1' }
  const saved = saveCreativeProject(p.id, p)
  const deps: Deps = {
    ...toolDependencies,
    json: async () => ({
      videos: [
        {
          id: 11,
          url: 'https://pexels.com/video/11',
          image: 'https://images.pexels.com/11.jpg',
          duration: 2,
          user: { name: 'Artist', url: 'https://pexels.com/@artist' },
          video_files: [
            { link: 'https://videos.pexels.com/11.mp4', file_type: 'video/mp4', width: 64, height: 64 },
          ],
        },
      ],
    }),
    bytes: async () => fs.readFile(path.join(directory, 'static/uploads/source.mp4')),
  }
  const s = service(deps),
    start = async (...args: Parameters<typeof s.start>) => {
      const j = await s.start(...args)
      await s.idle(j.id)
      return getToolJob(args[0], j.id)
    }
  const tools = {
    ...extensionTools,
    start,
    import: (id: number, job: number, candidate: string, revision: number) =>
      importStockCandidate(id, job, candidate, revision, deps),
  }
  const first = await executeExtensions(context(saved, 'research'), tools)
  assert.equal(first?.waiting, true)
  assert.equal(first?.revision, saved.revision + 1)
  const fresh = getCreativeProject(p.id)
  assert.equal(fresh.production.sources.length, 1)
  assert.equal(await executeExtensions(context(fresh, 'research'), tools), null)
  assert.equal(getCreativeProject(p.id).revision, fresh.revision)
})

test('service timeout pauses polling; recovery queries the same remote job', async () => {
  const p = create(),
    model = await uploadCreativeModel(p.id, 'human.glb', glb())
  let posts = 0
  const s = service({
    json: async (_u, _k, body) => {
      if (body) {
        posts++
        return { result: 'slow-task' }
      }
      return { status: 'IN_PROGRESS', progress: 25 }
    },
  })
  const j = await s.start(p.id, 1, 'rigging', { modelId: model.id })
  await s.idle(j.id)
  s.dispose()
  db.update(schema.creativeToolJobs)
    .set({ createdAt: '2020-01-01T00:00:00Z' })
    .where(eq(schema.creativeToolJobs.id, j.id))
    .run()
  s.recover()
  await s.idle(j.id)
  assert.equal(getToolJob(p.id, j.id).status, 'failed')
  assert.match(getToolJob(p.id, j.id).error!, /6小时/)
  s.resume(p.id, j.id)
  await s.idle(j.id)
  assert.equal(getToolJob(p.id, j.id).status, 'running')
  assert.equal(posts, 1)
  s.dispose()
})
