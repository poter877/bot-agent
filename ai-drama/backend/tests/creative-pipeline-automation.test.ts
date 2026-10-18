import assert from 'node:assert/strict'
import { test, after, before } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-automation-'))
process.env.SQLITE_PATH = path.join(folder, 'test.sqlite')
process.env.STORAGE_PATH = path.join(folder, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema, getInsertId } = await import('../src/db/index.js')
const { createCreativeDocument } = await import('../src/services/creative-model.js')
const { getCreativeProject } = await import('../src/services/creative-projects.js')
const { createPipelineRunner, getPipelineState } = await import('../src/services/creative-pipeline/runner.js')
const { createStageExecutor, pipelineTools } = await import('../src/services/creative-pipeline/executor.js')
const { pipelineDefinitions } = await import('../src/services/creative-pipeline/definitions.js')
const { toolboxService, listToolboxJobs } = await import('../src/services/production-tools/jobs.js')
const { saveCreativeProject } = await import('../src/services/creative-projects.js')
const { withPipelineAutomation } = await import('../src/services/creative-pipeline/automation.js')
const { ffmpegPath } = await import('../src/utils/ffmpeg.js')
import type { PipelineToolRuntime } from '../src/services/creative-pipeline/tool-contracts.js'
const runners: ReturnType<typeof createPipelineRunner>[] = []
before(async () => {
  await fs.mkdir(path.join(folder, 'static', 'uploads'), { recursive: true })
  execFileSync(ffmpegPath!, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=96x64:r=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440',
    '-t',
    '1.2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    path.join(folder, 'static', 'uploads', 'source.mp4'),
  ])
  execFileSync(ffmpegPath!, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=660',
    '-t',
    '1.2',
    path.join(folder, 'static', 'uploads', 'music.wav'),
  ])
})

for (const composer of ['video_compose', 'hyperframes_compose', 'video_stitch', 'bgm_montage_lite'])
  test(`${composer} runs inside compose with actual audio, and post-caption video reaches QA and delivery`, async () => {
    let project = create('cinematic')
    const automation = {
      postTools: [composer, 'remotion_caption_burn'],
      toolParameters:
        composer === 'video_stitch'
          ? { video_stitch: { transition: 'crossfade', transition_duration: 0.1 } }
          : composer === 'bgm_montage_lite'
            ? { bgm_montage_lite: { shot_duration: 0.5 } }
            : {},
    }
    project = saveCreativeProject(project.id, {
      ...project,
      shots: [project.shots[0], { ...project.shots[0], id: 'two', title: '第二段' }],
      audio: { ...project.audio, musicUrl: '/static/uploads/music.wav' },
      production: {
        ...project.production,
        fields: { ...project.production.fields, automation: JSON.stringify(automation) },
      },
    })
    const runner = createPipelineRunner(
      createStageExecutor({
        ...pipelineTools,
        narrative: async () => ({ summary: '主题', content: '保持实际媒体', checks: [] }),
        plan: async (ctx) => ctx.project,
      }),
      100000,
    )
    runners.push(runner)
    runner.start(project.id, project.revision)
    for (let n = 0; n < 160 && getPipelineState(project.id).run!.status !== 'completed'; n++) {
      const run = getPipelineState(project.id).run!
      assert.notEqual(run.status, 'failed', run.error || 'workflow failed')
      if (run.status === 'review') runner.approve(project.id, run.id, run.version)
      else {
        runner.continue(project.id, run.id, run.version)
        await runner.idle(run.id)
      }
      for (const job of listToolboxJobs(project.id))
        if (['queued', 'running'].includes(job.status)) await toolboxService.idle(job.id)
    }
    const run = getPipelineState(project.id).run!
    assert.equal(run.status, 'completed')
    const composed = run.stages.find((stage) => stage.id === 'compose')!.artifact!
    const steps = (composed.data!.toolRuntime as PipelineToolRuntime).steps
    assert.ok(steps.some((step) => step.toolId === composer && step.status === 'completed'))
    const burned = steps.find((step) => step.toolId === 'remotion_caption_burn')!
    assert.equal(burned.status, 'completed')
    const output = (composed.data!.outputs as { videoUrl: string }[])[0]
    assert.equal(output.videoUrl, burned.files!.find((file) => file.kind === 'video')!.url)
    const qa = steps.find((step) => step.toolId === 'visual_qa')!
    assert.equal(qa.resolvedArgs!.sourceUrl, output.videoUrl)
    const publish = run.stages.find((stage) => stage.id === 'publish')!.artifact!
    const bundle = (publish.data!.toolRuntime as PipelineToolRuntime).steps.find(
      (step) => step.toolId === 'export_bundle',
    )!
    assert.ok((bundle.resolvedArgs!.sourceUrls as string[]).includes(output.videoUrl))
    if (composer === 'bgm_montage_lite')
      assert.ok(Array.isArray(steps.find((step) => step.toolId === composer)!.data!.cuts))
  })

test('base task checkpoints preserve before-tool traces, and post-processing polls do not rerun the base', async () => {
  const project = create('cinematic'),
    definition = pipelineDefinitions.find((item) => item.category === 'cinematic')!,
    stage = definition.stages.find((item) => item.id === 'assets')!
  let previous: any = null,
    baseCalls = 0
  const execute = withPipelineAutomation(
    async (ctx) => {
      baseCalls++
      ctx.checkpoint({ summary: '基础任务', content: '任务已保留', checks: [], data: { taskId: 42 } })
      return {
        waiting: baseCalls === 1,
        artifact: { summary: '素材完成', content: '实际素材已就绪', checks: [], data: { manifest: [] } },
      }
    },
    {
      runTools: pipelineTools.runTools,
      toolPlan: (_ctx, phase) => [
        {
          key: phase,
          toolId: phase === 'before' ? 'visual_qa' : 'showcase_card',
          stage: 'assets',
          phase,
          role: phase === 'before' ? 'analysis' : 'visual',
          reason: '验证检查点',
          args:
            phase === 'before'
              ? { sourceUrl: '/static/uploads/source.mp4', operation: 'probe' }
              : { title: '工具产物' },
          dependsOn: [],
          apply: { target: 'artifact' },
        },
      ],
    },
  )
  let done = false
  for (let i = 0; i < 20 && !done; i++) {
    const result = await execute({
      project: getCreativeProject(project.id),
      definition,
      stage,
      artifacts: {},
      previous,
      retry: false,
      checkpoint: (artifact) => {
        previous = artifact
      },
    })
    previous = result.artifact
    done = !result.waiting
    for (const job of listToolboxJobs(project.id))
      if (['queued', 'running'].includes(job.status)) await toolboxService.idle(job.id)
  }
  assert.equal(done, true)
  assert.equal(baseCalls, 2)
  assert.equal((previous.data.toolRuntime as PipelineToolRuntime).steps.length, 2)
  assert.equal(listToolboxJobs(project.id).length, 2)
})
after(async () => {
  runners.forEach((r) => r.dispose())
  toolboxService.dispose()
  await fs.rm(folder, { recursive: true, force: true })
})
function create(category: Parameters<typeof createCreativeDocument>[0]) {
  const doc = createCreativeDocument(category)
  doc.brief.idea = '沿用真实来源制作并检查实际产物'
  doc.brief.targetDuration = 5
  doc.production.sources = [
    {
      id: randomUUID(),
      name: '真实原片',
      kind: 'video',
      url: '/static/uploads/source.mp4',
      duration: 1.2,
      coverUrl: null,
      transcript: '1\n00:00:00,000 --> 00:00:00,500\n原片原文',
      attribution: '测试生成的声音和画面',
    },
  ]
  const character = category === 'character_animation',
    diagram = category === 'explainer'
  doc.shots = [
    {
      id: 'one',
      title: '第一段',
      duration: 0.5,
      visualPrompt: '展示已经批准的内容',
      narration: '',
      caption: '原片原文',
      mediaType: character ? 'video' : diagram ? 'image' : 'video',
      imageUrl: null,
      videoUrl: character || diagram ? null : '/static/uploads/source.mp4',
      audioUrl: null,
      audioTrimStart: 0,
      trimStart: 0,
      originalVolume: 1,
      imageTaskId: null,
      videoTaskId: null,
      ...(character
        ? {
            toolPlan: {
              toolId: 'character_rig_renderer',
              args: {
                characters: [{ id: 'host', name: '讲解者', color: '#6da8ff', bodyHeight: 180 }],
                actions: [{ characterId: 'host', start: 0, end: 0.5, pose: 'wave', x: 0.5, toX: 0.5 }],
              },
            },
          }
        : {}),
    },
  ]
  const timestamp = new Date().toISOString()
  const id = getInsertId(
    db
      .insert(schema.dramas)
      .values({
        title: '完整流程测试',
        projectType: 'creative',
        creativeCategory: category,
        aspectRatio: category === 'localization' ? '1:1' : '16:9',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run(),
  )
  db.insert(schema.creativeProjects)
    .values({ projectId: id, document: JSON.stringify(doc), revision: 1, updatedAt: timestamp })
    .run()
  return getCreativeProject(id)
}
for (const definition of pipelineDefinitions)
  test(`${definition.id} invokes native tools, chains results, writes media back and delivers real playable video`, async () => {
    const project = create(definition.category),
      seen: string[] = []
    const execute = createStageExecutor({
      ...pipelineTools,
      narrative: async (context) => {
        seen.push(context.stage.id)
        return { summary: '已核对的阶段内容', content: '按真实素材及其工具分析规划后续制作。', checks: [] }
      },
      plan: async (context) => context.project,
      translate: async (document) => ({
        ...document,
        shots: document.shots.map((shot) => ({ ...shot, caption: 'Translated' })),
      }),
    })
    const runner = createPipelineRunner(execute, 100000)
    runners.push(runner)
    runner.start(project.id, project.revision)
    let iterations = 0
    while (getPipelineState(project.id).run!.status !== 'completed' && iterations++ < 160) {
      const run = getPipelineState(project.id).run!
      assert.notEqual(run.status, 'failed', run.error || 'workflow failed')
      if (run.status === 'review') runner.approve(project.id, run.id, run.version)
      else {
        runner.continue(project.id, run.id, run.version)
        await runner.idle(run.id)
      }
      for (const job of listToolboxJobs(project.id))
        if (['queued', 'running'].includes(job.status)) await toolboxService.idle(job.id)
      // The renderer has its own durable task, independently of tool workers.
      if (
        getCreativeProject(project.id).renders.some((render) =>
          ['pending', 'processing'].includes(render.status),
        )
      )
        await new Promise((resolve) => setTimeout(resolve, 40))
    }
    const run = getPipelineState(project.id).run!
    assert.equal(
      run.status,
      'completed',
      JSON.stringify(run.stages.map((stage) => ({ id: stage.id, status: stage.status, error: stage.error }))),
    )
    const traces = run.stages.flatMap(
      (stage) => (stage.artifact?.data?.toolRuntime as PipelineToolRuntime | undefined)?.steps ?? [],
    )
    assert.ok(traces.length > 0)
    assert.ok(
      traces.every((step) => step.status === 'completed'),
      JSON.stringify(traces),
    )
    assert.ok(traces.some((step) => step.toolId === 'visual_qa'))
    assert.ok(traces.some((step) => step.toolId === 'export_bundle'))
    assert.ok(traces.some((step) => step.toolId === 'subtitle_gen'))
    if (
      [
        'documentary',
        'hybrid',
        'talking_head',
        'screen_demo',
        'podcast',
        'clip_factory',
        'localization',
      ].includes(definition.category)
    )
      assert.ok(traces.some((step) => step.toolId === 'video_analyzer'))
    assert.ok(traces.every((step) => !!step.jobId))
    assert.equal(new Set(traces.map((step) => step.stage + ':' + step.key)).size, traces.length)
    for (const step of traces)
      for (const dependency of step.dependsOn)
        assert.ok(
          traces.find((candidate) => candidate.key === dependency && candidate.status === 'completed'),
        )
    const final = getCreativeProject(project.id),
      render = final.renders.find((render) => render.status === 'completed')!
    assert.ok(render)
    const video = render.videoUrl || render.outputs[0]?.videoUrl
    assert.ok((await fs.stat(path.join(folder, 'static', video!.replace(/^\/?static\//, '')))).size > 100)
    const bundle = traces
      .find((step) => step.toolId === 'export_bundle')!
      .files!.find((file) => file.kind === 'archive')!
    assert.ok((await fs.stat(path.join(folder, 'static', bundle.url.slice('/static/'.length)))).size > 100)
    if (definition.category === 'explainer') assert.ok(final.shots[0].imageUrl?.includes('/toolbox/'))
    if (definition.category === 'character_animation') {
      assert.ok(final.shots[0].videoUrl?.includes('/toolbox/'))
      assert.ok(traces.some((step) => step.toolId === 'svg_rig_builder'))
      assert.ok(traces.some((step) => step.toolId === 'action_timeline_compiler'))
      assert.ok(traces.some((step) => step.toolId === 'character_animation_reviewer'))
    }
    // Waiting for tools must not generate a new narrative for the same stage.
    assert.equal(new Set(seen).size, seen.length)
  })
