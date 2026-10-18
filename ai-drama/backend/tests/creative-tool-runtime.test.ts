import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-tools-'))
process.env.SQLITE_PATH = path.join(folder, 'runtime.sqlite')
process.env.STORAGE_PATH = path.join(folder, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema, getInsertId } = await import('../src/db/index.js')
const { createCreativeDocument } = await import('../src/services/creative-model.js')
const { getCreativeProject, saveCreativeProject, approveCreativeProject } = await import(
  '../src/services/creative-projects.js'
)
const { createToolboxService, applyToolboxOutput, listToolboxJobs, publicToolboxJob } = await import(
  '../src/services/production-tools/jobs.js'
)
const { executeTool } = await import('../src/services/production-tools/executor.js')
const { getPipelineDefinition } = await import('../src/services/creative-pipeline/definitions.js')
const { runPipelineTools, reconcilePipelineToolRevision } = await import(
  '../src/services/creative-pipeline/tool-runtime.js'
)
const { resolveToolBindings } = await import('../src/services/creative-pipeline/tool-bindings.js')
const { eq } = await import('drizzle-orm')
import type { StageContext, PipelineArtifact } from '../src/services/creative-pipeline/contracts.js'
import type { PipelineToolStep } from '../src/services/creative-pipeline/tool-contracts.js'
const services: ReturnType<typeof createToolboxService>[] = []
await fs.mkdir(path.join(folder, 'static'), { recursive: true })
function create() {
  const date = new Date().toISOString()
  const id = getInsertId(
    db
      .insert(schema.dramas)
      .values({
        title: '流程串联验证',
        projectType: 'creative',
        creativeCategory: 'explainer',
        createdAt: date,
        updatedAt: date,
      })
      .run(),
  )
  const document = createCreativeDocument()
  document.brief.idea = '验证工具真实串联'
  document.shots = [
    {
      id: 'shot-one',
      title: '图解',
      duration: 2,
      visualPrompt: '图解展示',
      narration: '',
      caption: '',
      mediaType: 'image',
      imageUrl: null,
      videoUrl: null,
      imageTaskId: null,
      videoTaskId: null,
      audioUrl: null,
      audioTrimStart: 0,
      trimStart: 0,
      originalVolume: 1,
    },
  ]
  db.insert(schema.creativeProjects)
    .values({ projectId: id, revision: 1, document: JSON.stringify(document), updatedAt: date })
    .run()
  return approveCreativeProject(id, 1)
}
const step = (
  key: string,
  toolId: string,
  args: Record<string, unknown>,
  rest: Partial<PipelineToolStep> = {},
): PipelineToolStep => ({
  key,
  toolId,
  args,
  stage: 'assets',
  phase: 'before',
  role: 'visual',
  reason: key,
  dependsOn: [],
  ...rest,
})
function context(
  projectId: number,
  state: { artifact: PipelineArtifact | null },
  retry = false,
): StageContext {
  const definition = getPipelineDefinition('explainer')!
  return {
    project: getCreativeProject(projectId),
    definition,
    stage: definition.stages.find((stage) => stage.id === 'assets')!,
    artifacts: {},
    previous: state.artifact,
    retry,
    checkpoint: (artifact: PipelineArtifact) => {
      state.artifact = structuredClone(artifact)
    },
  }
}
function service(executor = executeTool) {
  const result = createToolboxService(executor)
  services.push(result)
  return result
}
function deps(s: ReturnType<typeof createToolboxService>) {
  return {
    start: s.start,
    resume: s.resume,
    read(projectId: number, id: number) {
      const row = db
        .select()
        .from(schema.productionToolJobs)
        .where(eq(schema.productionToolJobs.id, id))
        .get()!
      assert.equal(row.projectId, projectId)
      return publicToolboxJob(row)
    },
  }
}
async function drain(
  id: number,
  planned: PipelineToolStep[],
  s: ReturnType<typeof createToolboxService>,
  state: { artifact: PipelineArtifact | null },
  retry = false,
) {
  for (let index = 0; index < 30; index++) {
    const result = await runPipelineTools(context(id, state, retry), planned, 'before', deps(s))
    if (!result.waiting) return result
    for (const task of result.runtime.steps) if (task.jobId) await s.idle(task.jobId)
  }
  assert.fail('流程工具未在预期轮询次数内完成')
}
after(async () => {
  for (const s of services) s.dispose()
  await fs.rm(folder, { recursive: true, force: true })
})

test('real local tools chain files, replace the shot, and retain approval without duplicate tasks', async () => {
  const p = create(),
    state = { artifact: null as PipelineArtifact | null },
    calls: string[] = []
  const s = service(async (ctx) => {
    calls.push(ctx.toolId)
    return executeTool(ctx)
  })
  const planned = [
    step('card', 'showcase_card', { title: '科学图解', width: 64, height: 64 }),
    step(
      'enlarge',
      'upscale',
      { sourceUrl: { $step: 'card', kind: 'image' }, scale: 2 },
      { dependsOn: ['card'], shotId: 'shot-one', apply: { target: 'shot', kind: 'image' } },
    ),
    step(
      'grade',
      'color_grade',
      { sourceUrl: { $step: 'enlarge', kind: 'image' }, preset: 'warm' },
      { dependsOn: ['enlarge'], shotId: 'shot-one', apply: { target: 'shot', kind: 'image' } },
    ),
  ]
  const result = await drain(p.id, planned, s, state)
  assert.deepEqual(calls, ['showcase_card', 'upscale', 'color_grade'])
  assert.equal(
    result.runtime.steps.every((item) => item.status === 'completed'),
    true,
  )
  const current = getCreativeProject(p.id),
    final = result.runtime.steps[2].files!.find((file) => file.kind === 'image')!
  assert.equal(current.shots[0].imageUrl, final.url)
  assert.equal(current.revision, 3)
  assert.equal(current.approvedRevision, current.revision)
  assert.equal(
    (await sharp(path.join(folder, 'static', final.url.slice('/static/'.length))).metadata()).width,
    128,
  )
  assert.equal(
    result.runtime.steps[1].resolvedArgs!.sourceUrl,
    result.runtime.steps[0].files!.find((file) => file.kind === 'image')!.url,
  )
  await drain(p.id, planned, s, state)
  assert.equal(listToolboxJobs(p.id).length, 3)
  assert.equal(calls.length, 3)
})

test('structured character outputs feed subsequent tools through native data bindings', async () => {
  const p = create(),
    state = { artifact: null as PipelineArtifact | null },
    s = service()
  const planned = [
    step('spec', 'character_spec_generator', {
      characters: [{ id: 'narrator', name: '讲解员', color: '#abcdef', bodyHeight: 180 }],
    }),
    step(
      'rig',
      'svg_rig_builder',
      { character_design: { $step: 'spec', dataPath: '' } },
      { dependsOn: ['spec'] },
    ),
    step(
      'poses',
      'pose_library_builder',
      { rig_plan: { $step: 'rig', dataPath: '' } },
      { dependsOn: ['rig'] },
    ),
  ]
  const result = await drain(p.id, planned, s, state)
  assert.equal((result.runtime.steps[1].resolvedArgs!.character_design as any).characters[0].id, 'narrator')
  assert.ok(result.runtime.steps[2].data)
  assert.equal(result.revision, 1)
})

test('unknown submissions stay uncertain on retries and never automatically repost', async () => {
  const p = create(),
    state = { artifact: null as PipelineArtifact | null }
  let calls = 0
  const s = service(async (ctx) => {
    calls++
    ctx.checkpoint({ submissionStarted: true })
    throw new Error('network lost')
  })
  const planned = [step('request', 'showcase_card', { title: '未知提交' })]
  const started = await runPipelineTools(context(p.id, state), planned, 'before', deps(s))
  await s.idle(started.runtime.steps[0].jobId!)
  await assert.rejects(
    runPipelineTools(context(p.id, state, true), planned, 'before', deps(s)),
    /提交结果未知/,
  )
  await assert.rejects(
    runPipelineTools(context(p.id, state, true), planned, 'before', deps(s)),
    /提交结果未知/,
  )
  assert.equal(calls, 1)
  assert.equal((state.artifact!.data!.toolRuntime as any).steps[0].status, 'uncertain')
})

test('a failed known remote task resumes the same durable ID and imports its result', async () => {
  const p = create(),
    state = { artifact: null as PipelineArtifact | null }
  let calls = 0
  const s = service(async (ctx) => {
    calls++
    if (!ctx.state.remoteId) {
      ctx.checkpoint({ remoteId: 'remote-1', submissionStarted: true })
      throw new Error('temporary polling failure')
    }
    assert.equal(ctx.state.remoteId, 'remote-1')
    const file = path.join(ctx.outputDir, 'remote.png')
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#abcdef' } })
      .png()
      .toFile(file)
    return { summary: '恢复的结果', files: [{ path: file, name: 'remote.png', kind: 'image' }] }
  })
  const planned = [
    step('remote', 'showcase_card', { title: '远程恢复' }, { apply: { target: 'source', kind: 'image' } }),
  ]
  const started = await runPipelineTools(context(p.id, state), planned, 'before', deps(s)),
    jobId = started.runtime.steps[0].jobId!
  await s.idle(jobId)
  const done = await drain(p.id, planned, s, state, true)
  assert.equal(done.runtime.steps[0].jobId, jobId)
  assert.equal(listToolboxJobs(p.id).length, 1)
  assert.equal(calls, 2)
  assert.equal(getCreativeProject(p.id).production.sources.length, 1)
})

test('external edits are not overwritten while a tool result waits for writeback', async () => {
  const p = create(),
    state = { artifact: null as PipelineArtifact | null },
    s = service()
  const planned = [
    step(
      'card',
      'showcase_card',
      { title: '等待回写' },
      { shotId: 'shot-one', apply: { target: 'shot', kind: 'image' } },
    ),
  ]
  const initialContext = context(p.id, state),
    started = await runPipelineTools(initialContext, planned, 'before', deps(s))
  await s.idle(started.runtime.steps[0].jobId!)
  saveCreativeProject(p.id, { ...getCreativeProject(p.id), title: '用户修改的名称' })
  await assert.rejects(
    runPipelineTools({ ...initialContext, previous: state.artifact }, planned, 'before', deps(s)),
    /项目被修改/,
  )
  assert.equal(getCreativeProject(p.id).title, '用户修改的名称')
  assert.equal(getCreativeProject(p.id).shots[0].imageUrl, null)
})

test('interruption after apply reconciles exactly our write and rejects unrelated edits', async () => {
  const p = create(),
    state = { artifact: null as PipelineArtifact | null },
    s = service()
  const planned = [
    step(
      'card',
      'showcase_card',
      { title: '原子恢复', width: 64, height: 64 },
      { shotId: 'shot-one', apply: { target: 'shot', kind: 'image' } },
    ),
  ]
  const started = await runPipelineTools(context(p.id, state), planned, 'before', deps(s))
  await s.idle(started.runtime.steps[0].jobId!)
  await assert.rejects(
    runPipelineTools(context(p.id, state), planned, 'before', {
      ...deps(s),
      async apply(...args: Parameters<typeof applyToolboxOutput>) {
        await applyToolboxOutput(...args)
        throw new Error('simulated process loss')
      },
    }),
  )
  assert.equal(getCreativeProject(p.id).revision, 2)
  assert.equal(reconcilePipelineToolRevision(p.id, 1, state.artifact), 2)
  assert.equal(getCreativeProject(p.id).approvedRevision, 2)
  const p2 = create(),
    state2 = { artifact: null as PipelineArtifact | null }
  const run2 = await runPipelineTools(context(p2.id, state2), planned, 'before', deps(s))
  await s.idle(run2.runtime.steps[0].jobId!)
  saveCreativeProject(p2.id, { ...getCreativeProject(p2.id), title: '无关手工修改' })
  assert.equal(reconcilePipelineToolRevision(p2.id, 1, state2.artifact), null)
})

test('binding lookup rejects prototype paths and treats output as plain data', () => {
  const record = {
    ...step('x', 'showcase_card', {}),
    status: 'completed' as const,
    data: { nested: [{ id: 'trusted-id' }] },
  }
  assert.equal(
    resolveToolBindings({ selected: { $step: 'x', dataPath: 'nested[0].id' } }, [record]).selected,
    'trusted-id',
  )
  assert.throws(
    () => resolveToolBindings({ value: { $step: 'x', dataPath: '__proto__.polluted' } }, [record]),
    /引用路径无效/,
  )
  assert.throws(() => resolveToolBindings({ value: { $step: 'missing' } }, [record]), /尚未就绪/)
})

test('tool dependency cycles and missing prerequisites stop before any request', async () => {
  const p = create(),
    state = { artifact: null as PipelineArtifact | null },
    s = service()
  await assert.rejects(
    runPipelineTools(
      context(p.id, state),
      [
        step('a', 'showcase_card', { title: 'a' }, { dependsOn: ['b'] }),
        step('b', 'showcase_card', { title: 'b' }, { dependsOn: ['a'] }),
      ],
      'before',
      deps(s),
    ),
    /依赖存在循环/,
  )
  await assert.rejects(
    runPipelineTools(
      context(p.id, state),
      [step('a', 'showcase_card', { title: 'a' }, { dependsOn: ['missing'] })],
      'before',
      deps(s),
    ),
    /缺少前序/,
  )
  assert.equal(listToolboxJobs(p.id).length, 0)
})

test('explicit failed quality reports persist and prevent dependent delivery', async () => {
  const p = create(),
    state = { artifact: null as PipelineArtifact | null }
  const s = service(async () => ({
    summary: '视频质量检查',
    files: [],
    data: { passed: false, issues: ['编码尺寸不符'] },
  }))
  const planned = [
    step('qa', 'visual_qa', { sourceUrl: '/static/placeholder.mp4' }, { role: 'analysis' }),
    step('delivery', 'export_bundle', { sourceUrls: [] }, { dependsOn: ['qa'], role: 'delivery' }),
  ]
  const started = await runPipelineTools(context(p.id, state), planned, 'before', deps(s))
  await s.idle(started.runtime.steps[0].jobId!)
  await assert.rejects(runPipelineTools(context(p.id, state), planned, 'before', deps(s)), /检查未通过/)
  assert.equal(listToolboxJobs(p.id).length, 1)
  assert.deepEqual((state.artifact!.data!.toolRuntime as any).steps[0].data.issues, ['编码尺寸不符'])
})

function wave(seconds = 2) {
  const sampleRate = 16000,
    samples = sampleRate * seconds,
    buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(buffer.length - 8, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++)
    buffer.writeInt16LE(Math.round(Math.sin((i / sampleRate) * Math.PI * 440 * 2) * 3000), 44 + i * 2)
  return buffer
}
test('generated narration and music automatically enter global audio tracks and retain approval', async () => {
  const p = create(),
    state = { artifact: null as PipelineArtifact | null }
  const s = service(async (ctx) => {
    const file = path.join(ctx.outputDir, 'sound.wav')
    await fs.writeFile(file, wave())
    return { summary: '音轨', files: [{ path: file, name: 'sound.wav', kind: 'audio' }] }
  })
  const planned = [
    step(
      'voice',
      'audio_enhance',
      { sourceUrl: '/static/source.wav' },
      { role: 'voice', apply: { target: 'narration', kind: 'audio' } },
    ),
    step(
      'music',
      'audio_enhance',
      { sourceUrl: '/static/music.wav' },
      { role: 'music', apply: { target: 'music', kind: 'audio' } },
    ),
  ]
  const done = await drain(p.id, planned, s, state),
    current = getCreativeProject(p.id)
  assert.equal(current.audio.narrationUrl, done.runtime.steps[0].files![0].url)
  assert.equal(current.audio.musicUrl, done.runtime.steps[1].files![0].url)
  assert.equal(current.approvedRevision, 3)
  assert.equal(current.revision, 3)
})

test('real generated VTT subtitles automatically write timed transcript into their source', async () => {
  const p = create(),
    sourceId = (await import('node:crypto')).randomUUID(),
    relative = `creative/${p.id}/source.wav`
  await fs.mkdir(path.join(folder, 'static', 'creative', String(p.id)), { recursive: true })
  await fs.writeFile(path.join(folder, 'static', relative), wave())
  const source = {
    id: sourceId,
    name: '原声',
    kind: 'audio' as const,
    url: '/static/' + relative,
    duration: 2,
    coverUrl: null,
    transcript: '',
    attribution: '',
  }
  saveCreativeProject(p.id, { ...p, production: { ...p.production, sources: [source] } }, source)
  const state = { artifact: null as PipelineArtifact | null },
    s = service()
  const done = await drain(
    p.id,
    [
      step(
        'subtitles',
        'subtitle_gen',
        { segments: [{ start: 0, end: 1.8, text: '真实时码字幕' }], format: 'vtt' },
        { role: 'post', sourceId, apply: { target: 'transcript', kind: 'subtitle' } },
      ),
    ],
    s,
    state,
  )
  assert.equal(done.runtime.steps[0].writeback, 'transcript')
  assert.match(getCreativeProject(p.id).production.sources[0].transcript, /00:00:00,000 --> 00:00:01,800/)
  assert.match(getCreativeProject(p.id).production.sources[0].transcript, /真实时码字幕/)
  const before = getCreativeProject(p.id).revision
  await drain(
    p.id,
    [
      step(
        'subtitles',
        'subtitle_gen',
        {},
        { role: 'post', sourceId, apply: { target: 'transcript', kind: 'subtitle' } },
      ),
    ],
    s,
    state,
  )
  assert.equal(getCreativeProject(p.id).revision, before)
})

test('a real video passes native QA, writes a render record, and feeds a downloadable delivery archive', async () => {
  const p = create(),
    state = { artifact: null as PipelineArtifact | null },
    s = service()
  const planned = [
    step(
      'video',
      'showcase_card',
      { title: '实际视频输出', render_video: true, width: 64, height: 64, duration_seconds: 1, fps: 2 },
      { role: 'post', apply: { target: 'render', kind: 'video' } },
    ),
    step(
      'qa',
      'visual_qa',
      {
        sourceUrl: { $step: 'video', kind: 'video' },
        operation: 'probe',
        expected: { width: 64, height: 64, min_duration: 0.9 },
      },
      { role: 'analysis', dependsOn: ['video'] },
    ),
    step(
      'package',
      'export_bundle',
      { sourceUrls: [{ $step: 'video', kind: 'video' }], title: '交付包' },
      { role: 'delivery', dependsOn: ['qa'], apply: { target: 'delivery', kind: 'archive' } },
    ),
  ]
  const result = await drain(p.id, planned, s, state),
    renders = getCreativeProject(p.id).renders
  assert.equal(renders.length, 1)
  assert.equal(renders[0].status, 'completed')
  assert.equal(renders[0].videoUrl, result.runtime.steps[0].files!.find((file) => file.kind === 'video')!.url)
  assert.equal(result.runtime.steps[0].data!.renderId, renders[0].id)
  const persisted = (state.artifact!.data!.toolRuntime as any).steps[0]
  delete persisted.appliedRevision
  delete persisted.writeback
  persisted.data = {}
  const recovered = await drain(p.id, planned, s, state)
  assert.equal(getCreativeProject(p.id).renders.length, 1)
  assert.equal(recovered.runtime.steps[0].data!.renderId, renders[0].id)
  const archive = result.runtime.steps[2].files!.find((file) => file.kind === 'archive')!
  assert.equal(
    (await fs.readFile(path.join(folder, 'static', archive.url.slice('/static/'.length)))).readUInt32LE(0),
    0x04034b50,
  )
})

test('a durable submission lost before its stage ID checkpoint is recovered instead of submitted again', async () => {
  const p = create(),
    state = { artifact: null as PipelineArtifact | null },
    s = service()
  let requests = 0
  const planned = [step('once', 'showcase_card', { title: '提交后中断', width: 64, height: 64 })]
  await assert.rejects(
    runPipelineTools(context(p.id, state), planned, 'before', {
      ...deps(s),
      async start(...args: Parameters<typeof s.start>) {
        requests++
        await s.start(...args)
        throw new Error('lost before ID checkpoint')
      },
    }),
  )
  const job = listToolboxJobs(p.id)[0]
  await s.idle(job.id)
  const done = await drain(p.id, planned, s, state, true)
  assert.equal(done.runtime.steps[0].jobId, job.id)
  assert.equal(listToolboxJobs(p.id).length, 1)
  assert.equal(requests, 1)
})

test('a dependency graph is executed topologically even when declarations are reversed', async () => {
  const p = create(),
    state = { artifact: null as PipelineArtifact | null },
    s = service()
  const result = await drain(
    p.id,
    [
      step(
        'second',
        'upscale',
        { sourceUrl: { $step: 'first', kind: 'image' }, scale: 2 },
        { dependsOn: ['first'] },
      ),
      step('first', 'showcase_card', { title: '拓扑执行', width: 64, height: 64 }),
    ],
    s,
    state,
  )
  assert.equal(
    result.runtime.steps.every((item) => item.status === 'completed'),
    true,
  )
  assert.equal(listToolboxJobs(p.id).length, 2)
})

test('untimed recognition writes real transcript text without creating subtitle timing', async () => {
  const p = create(),
    sourceId = (await import('node:crypto')).randomUUID(),
    relative = `creative/${p.id}/original.wav`
  await fs.mkdir(path.join(folder, 'static', 'creative', String(p.id)), { recursive: true })
  await fs.writeFile(path.join(folder, 'static', relative), wave())
  const source = {
    id: sourceId,
    name: '原始音频',
    kind: 'audio' as const,
    url: '/static/' + relative,
    duration: 2,
    coverUrl: null,
    transcript: '',
    attribution: '',
  }
  saveCreativeProject(p.id, { ...p, production: { ...p.production, sources: [source] } }, source)
  const state = { artifact: null as PipelineArtifact | null },
    s = service(async (ctx) => {
      const file = path.join(ctx.outputDir, 'transcription.json')
      await fs.writeFile(file, JSON.stringify({ text: '实际识别的文本原稿' }))
      return {
        summary: '无时码识别结果',
        files: [{ path: file, name: 'transcription.json', kind: 'data' }],
        data: { text: '实际识别的文本原稿' },
      }
    })
  const done = await drain(
    p.id,
    [
      step(
        'text-transcript',
        'audio_probe',
        { sourceUrl: source.url },
        { role: 'analysis', sourceId, apply: { target: 'transcript', sourceId, kind: 'data' } },
      ),
    ],
    s,
    state,
  )
  assert.equal(getCreativeProject(p.id).production.sources[0].transcript, '实际识别的文本原稿')
  assert.equal(done.runtime.steps[0].data!.transcriptTiming, 'untimed')
  assert.equal(getCreativeProject(p.id).shots[0].caption, '')
})

test('real silence cutting updates video and shot duration together while preserving source transcript', async () => {
  const p = create(),
    root = path.join(folder, 'static', 'creative', String(p.id)),
    sourceId = (await import('node:crypto')).randomUUID()
  await fs.mkdir(root, { recursive: true })
  const pcm = wave(2)
  pcm.fill(0, 44 + 16000, 44 + 48000)
  await fs.writeFile(path.join(root, 'input.wav'), pcm)
  const { execFile } = await import('node:child_process'),
    { promisify } = await import('node:util'),
    { ffmpegPath } = await import('../src/utils/ffmpeg.js')
  await promisify(execFile)(ffmpegPath!, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=64x64:r=10:d=2',
    '-i',
    path.join(root, 'input.wav'),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    path.join(root, 'input.mp4'),
  ])
  const url = `/static/creative/${p.id}/input.mp4`,
    source = {
      id: sourceId,
      name: '含静音原片',
      kind: 'video' as const,
      url,
      duration: 2,
      coverUrl: null,
      transcript: '原片完整原稿不改动',
      attribution: '',
    }
  const updated = saveCreativeProject(
    p.id,
    {
      ...p,
      shots: p.shots.map((shot) => ({
        ...shot,
        mediaType: 'video',
        videoUrl: url,
        caption: '保留完整原句',
        duration: 2,
      })),
      production: { ...p.production, sources: [source] },
    },
    source,
  )
  approveCreativeProject(p.id, updated.revision)
  const state = { artifact: null as PipelineArtifact | null },
    s = service()
  const done = await drain(
    p.id,
    [
      step(
        'silence',
        'silence_cutter',
        { sourceUrl: url, operation: 'cut', threshold_db: -30, min_silence_seconds: 0.3 },
        { role: 'post', shotId: 'shot-one', apply: { target: 'shot', shotId: 'shot-one', kind: 'video' } },
      ),
    ],
    s,
    state,
  )
  const current = getCreativeProject(p.id),
    shot = current.shots[0]
  assert.ok(shot.duration < 1.5 && shot.duration > 0.5, `实际裁切时长: ${shot.duration}`)
  assert.equal(shot.duration, done.runtime.steps[0].data!.appliedDuration)
  assert.equal(shot.videoUrl, done.runtime.steps[0].files!.find((file) => file.kind === 'video')!.url)
  assert.equal(shot.trimStart, 0)
  assert.equal(shot.caption, '保留完整原句')
  assert.equal(current.production.sources[0].transcript, '原片完整原稿不改动')
  assert.equal(current.approvedRevision, current.revision)
})

test('short TTS is padded to the approved shot and stays audible when original video sound is muted', async () => {
  const p = create(),
    initial = saveCreativeProject(p.id, {
      ...p,
      shots: p.shots.map((shot) => ({ ...shot, narration: '短配音', originalVolume: 0 })),
    })
  approveCreativeProject(p.id, initial.revision)
  const state = { artifact: null as PipelineArtifact | null }
  let speechCalls = 0
  const s = service(async (ctx) => {
    if (ctx.toolId !== 'audio_probe') return executeTool(ctx)
    speechCalls++
    const file = path.join(ctx.outputDir, 'raw.wav')
    await fs.writeFile(file, wave(0.4))
    return { summary: '真实短配音', files: [{ path: file, name: 'raw.wav', kind: 'audio' }] }
  })
  const planned = [
    step(
      'image',
      'showcase_card',
      { title: '配音画面', width: 64, height: 64 },
      { shotId: 'shot-one', apply: { target: 'shot', kind: 'image' } },
    ),
    step(
      'speech',
      'audio_probe',
      { sourceUrl: '/static/placeholder.wav' },
      { role: 'voice', shotId: 'shot-one', apply: { target: 'shot', kind: 'audio' } },
    ),
  ]
  const done = await drain(p.id, planned, s, state),
    current = getCreativeProject(p.id),
    voice = done.runtime.steps[1]
  assert.equal((voice.data!.speechFit as any).targetDuration, 2)
  assert.equal((voice.data!.speechFit as any).padded, true)
  assert.equal(current.shots[0].audioUrl, voice.files![0].url)
  assert.equal(voice.files!.length, 2)
  assert.notEqual(voice.files![0].url, voice.data!.rawAudioUrl)
  const { renderCreativeVideo } = await import('../src/services/creative-renderer.js')
  const render = await renderCreativeVideo({ ...current, projectId: current.id })
  const { execFile } = await import('node:child_process'),
    { promisify } = await import('node:util'),
    { ffmpegPath } = await import('../src/utils/ffmpeg.js')
  const { stdout } = await promisify(execFile)(
    ffmpegPath!,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      path.join(folder, 'static', render.videoUrl.replace(/^\/?static\//, '')),
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      's16le',
      'pipe:1',
    ],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 },
  )
  const pcm = stdout as Buffer
  let energy = 0
  for (let sample = 0; sample < 4800; sample++) energy += pcm.readInt16LE(sample * 2) ** 2
  assert.ok(Math.sqrt(energy / 4800) > 100, '新增配音应保留真实可听声音，不能被原声音量0静音')
  await drain(p.id, planned, s, state)
  assert.equal(speechCalls, 1)
  assert.equal(getCreativeProject(p.id).approvedRevision, current.revision)
})

test('TTS up to 1.5x is fitted locally and excessive speech pauses without another generation', async () => {
  const p = create(),
    state = { artifact: null as PipelineArtifact | null }
  let calls = 0
  const s = service(async (ctx) => {
    calls++
    const file = path.join(ctx.outputDir, 'raw.wav')
    await fs.writeFile(file, wave(2.4))
    return { summary: '配音', files: [{ path: file, name: 'raw.wav', kind: 'audio' }] }
  })
  const planned = [
    step(
      'voice',
      'audio_probe',
      { sourceUrl: '/static/placeholder.wav' },
      { role: 'voice', shotId: 'shot-one', apply: { target: 'shot', kind: 'audio' } },
    ),
  ]
  const done = await drain(p.id, planned, s, state)
  assert.ok(Math.abs((done.runtime.steps[0].data!.speechFit as any).speed - 1.2) < 0.01)
  assert.equal(calls, 1)
  const p2 = create(),
    state2 = { artifact: null as PipelineArtifact | null }
  const long = service(async (ctx) => {
    const file = path.join(ctx.outputDir, 'long.wav')
    await fs.writeFile(file, wave(3.2))
    return { summary: '过长配音', files: [{ path: file, name: 'long.wav', kind: 'audio' }] }
  })
  const started = await runPipelineTools(context(p2.id, state2), planned, 'before', deps(long))
  await long.idle(started.runtime.steps[0].jobId!)
  await assert.rejects(
    runPipelineTools(context(p2.id, state2), planned, 'before', deps(long)),
    /超过1.5倍语速/,
  )
  await assert.rejects(
    runPipelineTools(context(p2.id, state2, true), planned, 'before', deps(long)),
    /超过1.5倍语速/,
  )
  assert.equal(listToolboxJobs(p2.id).length, 1)
  assert.equal(getCreativeProject(p2.id).shots[0].audioUrl, null)
})

test('native avatar video adopts actual duration, recovers its write, extracts original voice and renders audible speech', async () => {
  const p = create(),
    changed = saveCreativeProject(p.id, {
      ...p,
      shots: p.shots.map((shot) => ({
        ...shot,
        duration: 5,
        mediaType: 'video',
        narration: '原生数字人实际讲稿',
        originalVolume: 0,
      })),
    })
  approveCreativeProject(p.id, changed.revision)
  const date = new Date().toISOString(),
    configId = getInsertId(
      db
        .insert(schema.aiServiceConfigs)
        .values({
          serviceType: 'avatar',
          provider: 'heygen',
          name: '隔离测试数字人',
          baseUrl: 'https://api.heygen.com',
          apiKey: 'isolated-test-key',
          model: 'avatar_iv',
          isActive: true,
          createdAt: date,
          updatedAt: date,
        })
        .run(),
    )
  const state = { artifact: null as PipelineArtifact | null }
  let providerCalls = 0
  const { execFile } = await import('node:child_process'),
    { promisify } = await import('node:util'),
    { ffmpegPath } = await import('../src/utils/ffmpeg.js')
  const s = service(async (ctx) => {
    if (ctx.toolId !== 'heygen_avatar') return executeTool(ctx)
    providerCalls++
    const file = path.join(ctx.outputDir, 'native-avatar.mp4')
    await promisify(execFile)(ffmpegPath!, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=green:s=96x64:r=10:d=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      file,
    ])
    return {
      summary: '原生数字人有声视频',
      files: [{ path: file, name: 'native-avatar.mp4', kind: 'video' }],
      data: { provider: 'heygen' },
    }
  })
  const planned = [
    step(
      'native-avatar',
      'heygen_avatar',
      { prompt: '原生讲解', text: '原生讲稿', voice_id: 'test-voice', avatar_id: 'test-avatar', duration: 5 },
      { role: 'visual', configId, shotId: 'shot-one', apply: { target: 'shot', kind: 'video' } },
    ),
    step(
      'native-voice',
      'audio_mixer',
      {
        sourceUrls: [{ $step: 'native-avatar', kind: 'video' }],
        operation: 'extract_audio',
        sample_rate: 48000,
        channels: 2,
      },
      {
        role: 'voice',
        dependsOn: ['native-avatar'],
        shotId: 'shot-one',
        apply: { target: 'shot', kind: 'audio' },
      },
    ),
  ]
  const started = await runPipelineTools(context(p.id, state), planned, 'before', deps(s))
  await s.idle(started.runtime.steps[0].jobId!)
  const baseContext = context(p.id, state)
  await assert.rejects(
    runPipelineTools(
      {
        ...baseContext,
        checkpoint: (artifact, revision) => {
          if (revision === changed.revision + 1) throw new Error('simulated loss after avatar save')
          baseContext.checkpoint(artifact, revision)
        },
      },
      planned,
      'before',
      deps(s),
    ),
  )
  assert.ok(Math.abs(getCreativeProject(p.id).shots[0].duration - 3) < 0.1)
  assert.equal(reconcilePipelineToolRevision(p.id, changed.revision, state.artifact), changed.revision + 1)
  const done = await drain(p.id, planned, s, state),
    current = getCreativeProject(p.id)
  assert.equal(done.runtime.steps[0].data!.nativeAvatar, true)
  assert.ok(Math.abs(current.shots[0].duration - 3) < 0.1)
  assert.equal(current.shots[0].trimStart, 0)
  assert.ok(current.shots[0].audioUrl?.includes('voice-fitted-'))
  assert.ok(Math.abs((done.runtime.steps[1].data!.speechFit as any).targetDuration - 3) < 0.1)
  assert.equal(providerCalls, 1)
  assert.equal(listToolboxJobs(p.id).length, 2)
  const { renderCreativeVideo } = await import('../src/services/creative-renderer.js')
  const render = await renderCreativeVideo({ ...current, projectId: current.id })
  assert.ok(Math.abs(render.duration - 3) < 0.15)
  const { stdout } = await promisify(execFile)(
    ffmpegPath!,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      path.join(folder, 'static', render.videoUrl.replace(/^\/?static\//, '')),
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      's16le',
      'pipe:1',
    ],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 },
  )
  const pcm = stdout as Buffer
  let energy = 0
  for (let sample = 0; sample < 16000; sample++) energy += pcm.readInt16LE(sample * 2) ** 2
  assert.ok(Math.sqrt(energy / 16000) > 100)
  assert.equal(current.approvedRevision, current.revision)
})
