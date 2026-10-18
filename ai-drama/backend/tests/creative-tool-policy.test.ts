import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { StageContext } from '../src/services/creative-pipeline/contracts.js'
import type { StageKind } from '../src/services/creative-pipeline/definitions.js'
import type { CreativeCategory } from '../src/services/creative-catalog.js'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-tool-policy-'))
process.env.SQLITE_PATH = path.join(directory, 'test.sqlite')
process.env.HUOBAO_DATA_DIR = directory
process.env.STORAGE_PATH = path.join(directory, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db } = await import('../src/db/index.js')
const { createCreativeDocument } = await import('../src/services/creative-model.js')
const { pipelineDefinitions } = await import('../src/services/creative-pipeline/definitions.js')
const { pipelineToolPolicies, pipelineToolPoliciesFor } = await import(
  '../src/services/creative-pipeline/tool-policy.js'
)
const { planPipelineTools, parsePipelineAutomation } = await import(
  '../src/services/creative-pipeline/tool-planner.js'
)
const { default: inventory } = await import('../src/services/production-tools/inventory.json', {
  with: { type: 'json' },
})
after(async () => {
  db.$client.close()
  await fs.rm(directory, { recursive: true, force: true })
})

function context(
  category: CreativeCategory,
  stage: StageKind,
  automation: Record<string, unknown> = {},
): StageContext {
  const definition = pipelineDefinitions.find((item) => item.category === category)!
  const document = createCreativeDocument(category)
  document.brief.idea = '认识光合作用'
  document.brief.targetDuration = 8
  document.production.fields.automation = JSON.stringify(automation)
  document.production.sources = [
    {
      id: randomUUID(),
      name: '真实原片',
      kind: 'video',
      url: '/static/uploads/source.mp4',
      duration: 30,
      coverUrl: null,
      transcript: '1\n00:00:02,000 --> 00:00:05,000\n这是原片的真实原话\n',
      attribution: '用户提供',
    },
  ]
  document.shots = [
    {
      id: 'shot-one',
      title: '叶片与阳光',
      duration: 8,
      visualPrompt: '介绍叶片和阳光的作用',
      narration: '',
      caption: '叶片吸收阳光',
      mediaType: 'video',
      imageUrl: null,
      videoUrl: null,
      audioUrl: null,
      audioTrimStart: 0,
      trimStart: 0,
      originalVolume: 1,
      imageTaskId: null,
      videoTaskId: null,
    },
  ]
  const project = {
    ...document,
    id: 1,
    title: '真实测试',
    category,
    revision: 1,
    approvedRevision: 1,
    aspectRatio: '9:16',
    style: '3d',
    renders: [],
    recipe: {},
  } as unknown as StageContext['project']
  return {
    project,
    definition,
    stage: definition.stages.find((item) => item.id === stage) ?? {
      id: stage,
      title: stage,
      instruction: '',
      review: false,
      requires: [],
      produces: [],
    },
    artifacts: {},
    previous: null,
    retry: false,
    checkpoint: () => {},
  }
}
function scenePlan(ctx: StageContext, toolId: string, args: Record<string, unknown>, chain?: unknown[]) {
  Object.assign(ctx.project.shots[0], { toolPlan: { toolId, args, ...(chain ? { chain } : {}) } })
}

test('all 153 unique tools have explicit category, stage, purpose and activation policy', () => {
  assert.equal(Object.keys(pipelineToolPolicies).length, 153)
  assert.deepEqual(Object.keys(pipelineToolPolicies).sort(), inventory.map((item) => item.id).sort())
  for (const policy of Object.values(pipelineToolPolicies)) {
    assert.ok(
      policy.categories.length && policy.stages.length && policy.purpose.trim() && policy.trigger.trim(),
    )
    if (policy.mode === 'interactive') assert.equal(policy.selectionKey, 'capture')
    if (policy.selectionKey === 'image' || policy.selectionKey === 'video')
      assert.equal(policy.mode, 'selectable')
  }
  assert.equal(
    pipelineToolPoliciesFor('screen_demo').some((item) => item.toolId === 'sora_video'),
    false,
  )
  assert.equal(
    pipelineToolPoliciesFor('clip_factory', 'assets').some((item) => item.toolId === 'math_animate'),
    false,
  )
})

for (const definition of pipelineDefinitions)
  test(`${definition.id} selects real local work and final quality checks without cloud fan-out`, () => {
    const first = context(definition.category, definition.stages[0].id)
    const before = planPipelineTools(first, 'before')
    assert.ok(before.some((item) => item.toolId === 'video_analyzer'))
    assert.equal(
      before.some((item) => item.role === 'research' && item.toolId !== 'corpus_builder'),
      false,
    )
    assert.equal(
      before.some((item) => item.toolId.includes('tts') || item.toolId === 'video_selector'),
      false,
    )
    const edit = context(definition.category, 'edit')
    edit.project.shots[0].videoUrl = '/static/uploads/source.mp4'
    const planned = planPipelineTools(edit, 'before')
    assert.ok(planned.some((item) => item.toolId === 'composition_validator'))
    assert.ok(planned.some((item) => item.toolId === 'subtitle_gen'))
    const compose = context(definition.category, 'compose')
    compose.previous = {
      summary: '实际成片',
      content: '',
      checks: [],
      data: {
        outputs: [
          {
            videoUrl: '/static/creative/1/result.mp4',
            subtitleUrl: '/static/creative/1/result.srt',
            duration: 8,
          },
        ],
      },
    }
    assert.ok(planPipelineTools(compose, 'after').some((item) => item.toolId === 'visual_qa'))
  })

test('stock search binds stable selected ID into download and writes result into project sources', () => {
  const ctx = context('documentary', 'idea', { stockTool: 'nasa', analysis: 'off' })
  const steps = planPipelineTools(ctx, 'before')
  assert.equal(steps.length, 2)
  assert.equal(steps[0].args.download, false)
  assert.equal(steps[1].args.download, true)
  assert.deepEqual(steps[1].args.selected_id, { $step: steps[0].key, dataPath: 'items.0.id' })
  assert.deepEqual(steps[1].dependsOn, [steps[0].key])
  assert.equal(steps[1].apply?.target, 'source')
})
test('source-page discovery remains a research artifact and never pretends to download media', () => {
  const ctx = context('documentary', 'idea', { researchTool: 'esa', analysis: 'off' })
  const steps = planPipelineTools(ctx, 'before')
  assert.equal(steps.length, 1)
  assert.equal(steps[0].toolId, 'esa')
  assert.equal(steps[0].apply?.target, 'artifact')
  assert.equal(steps[0].args.download, undefined)
})
test('explicit provider selection makes exactly one visual call for each missing shot', () => {
  const ctx = context('cinematic', 'assets', { videoTool: 'veo_video' })
  const steps = planPipelineTools(ctx, 'before')
  assert.deepEqual(
    steps.map((item) => item.toolId),
    ['veo_video'],
  )
  assert.equal(steps[0].args.prompt, ctx.project.shots[0].visualPrompt)
  assert.equal(steps[0].apply?.shotId, 'shot-one')
  ctx.project.shots[0].videoUrl = '/static/creative/1/existing.mp4'
  assert.equal(planPipelineTools(ctx, 'before').length, 0)
})
test('automatic explainer diagrams use approved text without invented graph relationships', () => {
  const steps = planPipelineTools(context('explainer', 'assets'), 'before')
  assert.deepEqual(
    steps.map((item) => item.toolId),
    ['diagram_gen'],
  )
  assert.deepEqual(steps[0].args.boxes, [{ label: '叶片吸收阳光' }])
  assert.equal(steps[0].args.connections, undefined)
  assert.equal(steps[0].apply?.kind, 'image')
})
test('structured math and code scenes execute the named native renderer and carry precise input', () => {
  const math = context('explainer', 'assets')
  scenePlan(math, 'math_animate', { expression: 'sin(x+t)', x_min: -3, x_max: 3 })
  const planned = planPipelineTools(math, 'before')
  assert.equal(planned[0].toolId, 'math_animate')
  assert.equal(planned[0].args.expression, 'sin(x+t)')
  assert.equal(planned[0].apply?.kind, 'video')
  const code = context('screen_demo', 'assets')
  scenePlan(code, 'code_snippet', { code: 'const value = 1', language: 'typescript' })
  assert.equal(planPipelineTools(code, 'before')[0].args.code, 'const value = 1')
})
test('character animation passes real specification, rig, poses and timeline through six dependent steps', () => {
  const ctx = context('character_animation', 'assets')
  scenePlan(ctx, 'character_rig_renderer', {
    characters: [{ id: 'leaf', name: '叶子', color: '#22aa44' }],
    actions: [{ characterId: 'leaf', start: 0, end: 8, pose: 'wave', x: 0.5, toX: 0.5 }],
  })
  const steps = planPipelineTools(ctx, 'before')
  assert.deepEqual(
    steps.map((item) => item.toolId),
    [
      'character_spec_generator',
      'svg_rig_builder',
      'pose_library_builder',
      'action_timeline_compiler',
      'character_animation_reviewer',
      'character_rig_renderer',
    ],
  )
  assert.deepEqual(steps[1].args.character_design, { $step: steps[0].key, dataPath: '' })
  assert.deepEqual(steps[5].args.action_timeline, { $step: steps[3].key, dataPath: '' })
  assert.ok(steps[5].dependsOn.includes(steps[4].key))
  assert.equal(steps[5].apply?.kind, 'video')
  assert.throws(
    () => planPipelineTools(context('character_animation', 'assets'), 'before'),
    /角色列表与动作时间轴/,
  )
})
test('3D scenes request an actual movie and refuse missing world specification', () => {
  const ctx = context('animation', 'assets')
  scenePlan(ctx, 'threejs_world', { world_spec: { objects: [{ type: 'box', size: 1, color: '#aabbcc' }] } })
  const steps = planPipelineTools(ctx, 'before')
  assert.equal(steps[0].args.render_video, true)
  assert.equal(steps[0].apply?.kind, 'video')
  assert.equal(steps[0].apply?.target, 'shot')
  assert.throws(
    () => planPipelineTools(context('animation', 'assets', { visual: 'blender' }), 'before'),
    /world_spec/,
  )
})
test('scene processing chains keep analysis JSON separate from the previous actual media', () => {
  const ctx = context('explainer', 'assets')
  scenePlan(ctx, 'math_animate', { expression: 'sin(x+t)' }, [
    { toolId: 'visual_qa', args: {} },
    { toolId: 'color_grade', args: { preset: 'warm' } },
  ])
  // color grading is intentionally restricted to matching film workflows.
  assert.throws(() => planPipelineTools(ctx, 'before'), /不适合/)
  const film = context('cinematic', 'assets')
  scenePlan(film, 'veo_video', {}, [
    { toolId: 'visual_qa', args: {} },
    { toolId: 'color_grade', args: { preset: 'warm' } },
  ])
  const steps = planPipelineTools(film, 'before')
  assert.deepEqual(steps[2].args.sourceUrl, { $step: steps[0].key, kind: 'video' })
  assert.ok(steps[2].dependsOn.includes(steps[1].key))
})
test('model generation precedes character rigging and real rigged GLB files feed final scene rendering', () => {
  const design = context('character_animation', 'character_design', { modelTool: 'fal_3d' })
  assert.deepEqual(
    planPipelineTools(design, 'before').map((step) => step.toolId),
    ['fal_3d'],
  )
  const render = context('character_animation', 'assets', { modelTool: 'fal_3d' })
  render.artifacts.rig_plan = {
    summary: '真实绑定模型',
    content: '',
    checks: [],
    data: { files: [{ url: '/static/creative/1/rigged.glb', kind: 'model' }] },
  }
  scenePlan(render, 'blender_world', { world_spec: { objects: [] } })
  const planned = planPipelineTools(render, 'before')
  assert.deepEqual(planned[0].args.model_urls, ['/static/creative/1/rigged.glb'])
  assert.equal(
    planned.some((step) => step.toolId === 'fal_3d'),
    false,
  )
})
test('edited shot prompts override obsolete tool plan and service parameter prompts', () => {
  const ctx = context('cinematic', 'assets', { toolParameters: { veo_video: { prompt: '旧描述' } } })
  scenePlan(ctx, 'veo_video', { prompt: '另一个旧描述' })
  ctx.project.shots[0].visualPrompt = '用户编辑后的新画面'
  assert.equal(planPipelineTools(ctx, 'before')[0].args.prompt, '用户编辑后的新画面')
})
test('post-processing keeps analysis JSON out of the media chain and binds real face tracking data', () => {
  const ctx = context('talking_head', 'assets', {
    postTools: ['face_tracker', 'auto_reframe', 'audio_enhance', 'visual_qa'],
  })
  ctx.project.shots[0].videoUrl = '/static/uploads/source.mp4'
  ctx.project.shots[0].audioUrl = '/static/uploads/voice.wav'
  const steps = planPipelineTools(ctx, 'after')
  const tracker = steps.find((item) => item.toolId === 'face_tracker')!,
    frame = steps.find((item) => item.toolId === 'auto_reframe')!,
    voice = steps.find((item) => item.toolId === 'audio_enhance')!
  assert.equal(frame.args.sourceUrl, '/static/uploads/source.mp4')
  assert.deepEqual(frame.args.tracking, { $step: tracker.key, dataPath: '' })
  assert.equal(frame.args.mode, 'face')
  assert.equal(voice.args.sourceUrl, '/static/uploads/voice.wav')
  const qa = steps.filter((item) => item.toolId === 'visual_qa')
  assert.deepEqual(qa.at(-1)!.args.sourceUrl, { $step: frame.key })
})
test('selected speech and music create actual audio writebacks without replacing source text', () => {
  const ctx = context('avatar', 'assets', { speechTool: 'azure_tts', musicTool: 'suno_music' })
  ctx.project.plan.musicDirection = '轻柔钢琴'
  ctx.project.shots[0].narration = '这是一段批准讲稿'
  ctx.project.shots[0].videoUrl = '/static/uploads/source.mp4'
  const steps = planPipelineTools(ctx, 'before')
  assert.equal(steps.find((item) => item.toolId === 'suno_music')?.apply?.target, 'music')
  const speech = steps.find((item) => item.toolId === 'azure_tts')!
  assert.equal(speech.args.text, '这是一段批准讲稿')
  assert.equal(speech.apply?.kind, 'audio')
})
test('Sync avatar workflow waits for fitted speech and a real generated portrait before using the shot ID', () => {
  const ctx = context('avatar', 'assets', {
    avatarTool: 'lip_sync',
    speechTool: 'azure_tts',
    imageTool: 'openai_image',
  })
  ctx.project.shots[0].narration = '这是已批准的主持人讲稿'
  const steps = planPipelineTools(ctx, 'before')
  const speech = steps.find((step) => step.toolId === 'azure_tts')!,
    portrait = steps.find((step) => step.toolId === 'openai_image')!,
    avatar = steps.find((step) => step.toolId === 'lip_sync')!
  assert.equal(speech.role, 'voice')
  assert.equal(speech.apply?.kind, 'audio')
  assert.equal(portrait.apply?.kind, 'image')
  assert.deepEqual(avatar.dependsOn, [speech.key, portrait.key])
  assert.equal(avatar.args.shotId, 'shot-one')
  assert.equal(avatar.apply?.kind, 'video')
  assert.equal(steps.filter((step) => step.role === 'voice').length, 1)
})
test('Sync reuses existing audio and a bound portrait and never calls another speech model', () => {
  const ctx = context('avatar', 'assets', { avatarTool: 'kling_avatar', speechTool: 'openai_tts' })
  ctx.project.shots[0].audioUrl = '/static/uploads/approved-voice.wav'
  ctx.project.shots[0].imageUrl = '/static/uploads/portrait.png'
  const steps = planPipelineTools(ctx, 'before')
  assert.deepEqual(
    steps.map((step) => step.toolId),
    ['kling_avatar'],
  )
  assert.deepEqual(steps[0].dependsOn, [])
})
test('HeyGen uses native script and voice ID without a duplicate external TTS call', () => {
  const ctx = context('avatar', 'assets', {
    avatarTool: 'heygen_avatar',
    speechTool: 'azure_tts',
    toolParameters: { heygen_avatar: { avatar_id: 'real-avatar', voice_id: 'real-voice' } },
  })
  ctx.project.shots[0].narration = '批准的原生口播讲稿'
  const steps = planPipelineTools(ctx, 'before')
  assert.deepEqual(
    steps.map((step) => step.toolId),
    ['heygen_avatar', 'audio_mixer'],
  )
  assert.equal(steps[0].args.text, '批准的原生口播讲稿')
  assert.equal(steps[0].args.voice_id, 'real-voice')
  assert.equal(steps[0].args.avatar_id, 'real-avatar')
  assert.equal(steps[0].apply?.target, 'shot')
  assert.equal(steps[0].apply?.kind, 'video')
  assert.equal(steps[1].role, 'voice')
  assert.equal(steps[1].apply?.kind, 'audio')
  assert.deepEqual(steps[1].args.sourceUrls, [{ $step: steps[0].key, kind: 'video' }])
  assert.deepEqual(steps[1].dependsOn, [steps[0].key])
  ctx.project.shots[0].audioUrl = '/static/uploads/approved-voice.wav'
  assert.throws(() => planPipelineTools(ctx, 'before'), /已有独立配音请改选Sync/)
  ctx.previous = {
    summary: '已完成数字人视频',
    content: '',
    checks: [],
    data: { toolRuntime: { version: 1, steps: [{ ...steps[0], status: 'completed' }] } },
  }
  assert.equal(planPipelineTools(ctx, 'before').length, 2)
})
test('avatar input gaps stop before submission and explicitly disabled avatar paths preserve legacy behavior', () => {
  const missing = context('avatar', 'assets', { avatarTool: 'lip_sync', speechTool: 'openai_tts' })
  missing.project.shots[0].narration = '已批准讲稿'
  assert.throws(() => planPipelineTools(missing, 'before'), /人物画面|肖像/)
  const voice = context('avatar', 'assets', { avatarTool: 'lip_sync', speechTool: 'off' })
  voice.project.shots[0].imageUrl = '/static/uploads/portrait.png'
  voice.project.shots[0].narration = '已批准讲稿'
  assert.throws(() => planPipelineTools(voice, 'before'), /逐镜头真实配音/)
  assert.equal(planPipelineTools(context('avatar', 'assets', { avatarTool: 'off' }), 'before').length, 0)
  assert.equal(planPipelineTools(context('avatar', 'assets'), 'before').length, 0)
  const disabled = context('avatar', 'assets', { avatarTool: 'off' })
  disabled.project.shots[0].audioUrl = '/static/uploads/approved-voice.wav'
  disabled.project.shots[0].imageUrl = '/static/uploads/portrait.png'
  scenePlan(disabled, 'lip_sync', {})
  assert.throws(() => planPipelineTools(disabled, 'before'), /已关闭 avatarTool/)
})
test('transcription selection uses the same canonical field and rejects visual or speech aliases', () => {
  assert.equal(
    parsePipelineAutomation(context('talking_head', 'idea', { transcriptionTool: 'azure_stt' }).project)
      .transcriptionTool,
    'azure_stt',
  )
  const invalid = context('talking_head', 'idea', { transcriptionTool: 'openai_tts' })
  invalid.project.production.sources[0].transcript = ''
  assert.throws(() => planPipelineTools(invalid, 'before'), /transcription/)
})
test('ASR prepares actual mono WAV audio and text-only engines never invent timed captions', () => {
  for (const tool of ['azure_stt', 'dashscope_asr']) {
    const ctx = context('talking_head', 'idea', { transcriptionTool: tool })
    ctx.project.production.sources[0].transcript = ''
    const steps = planPipelineTools(ctx, 'before')
    const extract = steps.find((step) => step.toolId === 'audio_mixer')!,
      transcribe = steps.find((step) => step.toolId === tool)!
    assert.equal(extract.args.sample_rate, 16000)
    assert.equal(extract.args.channels, 1)
    assert.deepEqual(transcribe.args.audio_url, { $step: extract.key, kind: 'audio' })
    assert.equal(transcribe.apply?.kind, tool === 'dashscope_asr' ? 'data' : 'subtitle')
  }
})
test('recording stays opt-in and is never inferred from entering software demo workflow', () => {
  const noCapture = context('screen_demo', 'idea')
  assert.equal(
    planPipelineTools(noCapture, 'before').some((item) => item.role === 'interactive'),
    false,
  )
  const capture = context('screen_demo', 'idea', {
    capture: true,
    analysis: 'off',
    toolParameters: { screen_recorder: { duration_seconds: 12, screen_index: 2 } },
  })
  const steps = planPipelineTools(capture, 'before')
  assert.deepEqual(
    steps.map((item) => item.toolId),
    ['cap_recorder', 'screen_recorder'],
  )
  assert.equal(steps[1].apply?.target, 'source')
  assert.equal(steps[1].args.screen_index, 2)
})
test('editing trims the approved range before reframing and validates actual resulting files', () => {
  const ctx = context('clip_factory', 'edit')
  ctx.project.shots[0].videoUrl = '/static/uploads/source.mp4'
  ctx.project.shots[0].trimStart = 5
  const steps = planPipelineTools(ctx, 'before')
  const trim = steps.find((item) => item.toolId === 'video_trimmer')!,
    reframe = steps.find((item) => item.toolId === 'auto_reframe')!,
    validate = steps.find((item) => item.toolId === 'composition_validator')!
  assert.equal(trim.args.start_seconds, 5)
  assert.equal(trim.args.end_seconds, 13)
  assert.deepEqual(reframe.args.sourceUrl, { $step: trim.key, kind: 'video' })
  assert.deepEqual((validate.args.clips as Record<string, unknown>[])[0].sourceUrl, {
    $step: reframe.key,
    kind: 'video',
  })
})
test('delivery bundle uses real final outputs and runs after quality checks on pipelines without publish stage', () => {
  const ctx = context('documentary', 'compose')
  ctx.previous = {
    summary: '成片',
    content: '',
    checks: [],
    data: {
      outputs: [
        {
          videoUrl: '/static/creative/1/movie.mp4',
          subtitleUrl: '/static/creative/1/movie.srt',
          duration: 8,
        },
      ],
    },
  }
  const steps = planPipelineTools(ctx, 'after'),
    bundle = steps.find((item) => item.toolId === 'export_bundle')!
  assert.deepEqual(bundle.args.sourceUrls, ['/static/creative/1/movie.mp4', '/static/creative/1/movie.srt'])
  assert.equal(bundle.apply?.target, 'delivery')
  assert.ok(bundle.dependsOn.includes(steps.find((item) => item.toolId === 'visual_qa')!.key))
})
test('selected composition engine consumes the entire approved audio and picture timeline once', () => {
  const ctx = context('cinematic', 'compose', { postTools: ['hyperframes_compose'] })
  ctx.project.shots[0].videoUrl = '/static/uploads/source.mp4'
  ctx.project.shots[0].audioUrl = '/static/uploads/voice.wav'
  ctx.project.audio.musicUrl = '/static/uploads/music.wav'
  ctx.project.audio.narrationUrl = '/static/uploads/narration.wav'
  ctx.project.audio.musicVolume = 0.14
  const steps = planPipelineTools(ctx, 'before')
  assert.equal(steps.length, 1)
  assert.equal(steps[0].toolId, 'hyperframes_compose')
  assert.equal(steps[0].apply?.target, 'render')
  const timeline = steps[0].args.timeline as {
    shots: { audioUrl: string }[]
    narrationUrl: string
    musicUrl: string
    musicVolume: number
  }
  assert.equal(timeline.shots[0].audioUrl, '/static/uploads/voice.wav')
  assert.equal(timeline.narrationUrl, '/static/uploads/narration.wav')
  assert.equal(timeline.musicVolume, 0.14)
  const assets = context('cinematic', 'assets', { postTools: ['hyperframes_compose'] })
  assets.project.shots[0].videoUrl = '/static/uploads/source.mp4'
  assert.equal(
    planPipelineTools(assets, 'after').some((step) => step.toolId === 'hyperframes_compose'),
    false,
  )
})
test('clip delivery preserves independent video outputs with a selected compositor', () => {
  const ctx = context('clip_factory', 'compose', { postTools: ['video_compose'] })
  ctx.project.shots[0].videoUrl = '/static/uploads/source.mp4'
  ctx.project.shots.push({ ...ctx.project.shots[0], id: 'shot-two', title: '第二条', trimStart: 15 })
  const steps = planPipelineTools(ctx, 'before')
  assert.equal(steps.length, 2)
  assert.deepEqual(
    steps.map((step) => step.apply?.shotId),
    ['shot-one', 'shot-two'],
  )
  for (const step of steps) assert.equal((step.args.timeline as { shots: unknown[] }).shots.length, 1)
})
test('post-caption burning uses actual render output and quality checks the new file without duplicate burns', () => {
  const ctx = context('documentary', 'compose', { postTools: ['remotion_caption_burn'] })
  ctx.artifacts.compose = {
    summary: '实际成片',
    content: '',
    checks: [],
    data: {
      outputs: [
        {
          videoUrl: '/static/creative/1/movie.mp4',
          subtitleUrl: '/static/creative/1/movie.srt',
          duration: 8,
        },
      ],
    },
  }
  const steps = planPipelineTools(ctx, 'after'),
    burn = steps.find((step) => step.toolId === 'remotion_caption_burn')!
  assert.equal(burn.apply?.target, 'render')
  assert.equal(burn.args.sourceUrl, '/static/creative/1/movie.mp4')
  assert.deepEqual(steps.find((step) => step.toolId === 'visual_qa')?.args.sourceUrl, {
    $step: burn.key,
    kind: 'video',
  })
  assert.deepEqual((steps.find((step) => step.toolId === 'export_bundle')!.args.sourceUrls as unknown[])[0], {
    $step: burn.key,
    kind: 'video',
  })
  ctx.project.audio.burnSubtitles = true
  assert.equal(
    planPipelineTools(ctx, 'after').some((step) => step.toolId === 'remotion_caption_burn'),
    false,
  )
})
test('source analysis fingerprints change when actual transcripts change despite identical search query', () => {
  const ctx = context('documentary', 'idea')
  const first = planPipelineTools(ctx, 'before').find((step) => step.toolId === 'corpus_builder')!
  ctx.project.production.sources[0].transcript += '新的真实原稿'
  const second = planPipelineTools(ctx, 'before').find((step) => step.toolId === 'corpus_builder')!
  assert.notEqual(first.args.sourceFingerprint, second.args.sourceFingerprint)
})
test('invalid automation, unsupported category tools and missing required inputs stop before a call', () => {
  const invalid = context('explainer', 'assets')
  invalid.project.production.fields.automation = '{'
  assert.throws(() => parsePipelineAutomation(invalid.project), /格式不正确/)
  assert.throws(
    () => planPipelineTools(context('screen_demo', 'assets', { videoTool: 'veo_video' }), 'before'),
    /不适合/,
  )
  const missing = context('explainer', 'assets')
  scenePlan(missing, 'math_animate', {})
  assert.throws(() => planPipelineTools(missing, 'before'), /expression/)
  const unsafe = context('talking_head', 'assets', {
    postTools: ['silence_cutter'],
    toolParameters: { silence_cutter: { operation: 'cut' } },
  })
  unsafe.project.shots[0].videoUrl = '/static/uploads/source.mp4'
  unsafe.project.shots[0].audioUrl = '/static/uploads/independent-voice.wav'
  assert.throws(() => planPipelineTools(unsafe, 'after'), /独立配音/)
})
test('explicit silence removal first cuts only the approved range and writes the shorter real video back', () => {
  const ctx = context('talking_head', 'assets', {
    postTools: ['silence_cutter', 'auto_reframe'],
    toolParameters: { silence_cutter: { operation: 'cut' } },
  })
  ctx.project.shots[0].videoUrl = '/static/uploads/source.mp4'
  ctx.project.shots[0].trimStart = 3
  const steps = planPipelineTools(ctx, 'after')
  const trim = steps.find((step) => step.toolId === 'video_trimmer')!,
    cut = steps.find((step) => step.toolId === 'silence_cutter')!,
    frame = steps.find((step) => step.toolId === 'auto_reframe')!
  assert.equal(trim.args.start_seconds, 3)
  assert.equal(trim.args.end_seconds, 11)
  assert.deepEqual(cut.args.sourceUrl, { $step: trim.key, kind: 'video' })
  assert.equal(cut.apply?.target, 'shot')
  assert.equal(cut.args.pipeline_trimmed, true)
  assert.deepEqual(frame.args.sourceUrl, { $step: cut.key })
  assert.equal(steps.at(-1)!.args.expected, undefined)
})
