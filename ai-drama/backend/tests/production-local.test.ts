import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import sharp from 'sharp'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'production-local-'))
process.env.SQLITE_PATH = path.join(directory, 'test.sqlite')
process.env.HUOBAO_DATA_DIR = directory
process.env.STORAGE_PATH = path.join(directory, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { runLocalTool, localToolAvailability, LOCAL_TOOL_IDS, localToolFields } = await import(
  '../src/services/production-tools/local.js'
)
const { compileExpression } = await import('../src/services/production-tools/local-graphics.js')
const { ffmpegPath, ffprobePath } = await import('../src/utils/ffmpeg.js')
const root = process.env.STORAGE_PATH!,
  uploads = path.join(root, 'uploads'),
  jobs = path.join(root, 'creative', '1', 'tools')
let counter = 0
const source = '/static/uploads/source.mp4',
  audio = '/static/uploads/audio.wav',
  image = '/static/uploads/image.png'
function inspect(file: string) {
  return JSON.parse(
    execFileSync(
      ffprobePath || 'ffprobe',
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
      { encoding: 'utf8' },
    ),
  ) as {
    format: { duration: string }
    streams: { codec_type: string; width: number; height: number; channels: number }[]
  }
}
async function invoke(toolId: string, args: Record<string, unknown>, signal = new AbortController().signal) {
  return runLocalTool({
    projectId: 1,
    toolId,
    args,
    outputDir: path.join(jobs, String(++counter)),
    signal,
    progress: (value) => assert.ok(value >= 0 && value <= 1),
  })
}
before(async () => {
  await fs.mkdir(uploads, { recursive: true })
  await sharp({ create: { width: 160, height: 90, channels: 3, background: '#c65b45' } })
    .png()
    .toFile(path.join(uploads, 'image.png'))
  execFileSync(
    ffmpegPath || 'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=red:s=160x90:r=30:d=1',
      '-f',
      'lavfi',
      '-i',
      'color=blue:s=160x90:r=30:d=1',
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='if(lt(t,0.5)+gt(t,1.5),0.25*sin(2*PI*440*t),0)':s=48000:d=2",
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map',
      '[v]',
      '-map',
      '2:a',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '2',
      '-c:a',
      'aac',
      path.join(uploads, 'source.mp4'),
    ],
    { timeout: 30000 },
  )
  execFileSync(
    ffmpegPath || 'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      path.join(uploads, 'source.mp4'),
      '-vn',
      '-c:a',
      'pcm_s16le',
      path.join(uploads, 'audio.wav'),
    ],
    { timeout: 30000 },
  )
})
after(async () => {
  await fs.rm(directory, { recursive: true, force: true })
})

test('local catalog exposes executable schemas for every registered ID', () => {
  assert.equal(LOCAL_TOOL_IDS.length, 45)
  assert.equal(new Set(LOCAL_TOOL_IDS).size, LOCAL_TOOL_IDS.length)
  for (const id of LOCAL_TOOL_IDS) assert.equal(localToolFields[id].type, 'object')
})
test('face reframing uses tracked face coordinates, accepts left edge and rejects empty tracking', async () => {
  const reframed = await invoke('auto_reframe', {
    sourceUrl: source,
    aspect_ratio: '9:16',
    mode: 'face',
    tracking: {
      frames: [
        {
          time: 0,
          faces: [
            { focus_x: 0.8, width: 40, height: 40 },
            { focus_x: 0.1, width: 10, height: 10 },
          ],
        },
        { time: 0.5, faces: [{ focus_x: 0.6, width: 40, height: 40 }] },
        { time: 1, faces: [] },
        { time: 1.5, faces: [{ focus_x: 0.7, width: 40, height: 40 }] },
      ],
    },
  })
  assert.equal(reframed.data?.focusX, 0.7)
  assert.equal(reframed.data?.tracked, true)
  assert.equal(
    inspect(reframed.files[0].path).streams.find((stream) => stream.codec_type === 'video')?.height,
    1280,
  )
  const edge = await invoke('auto_reframe', { sourceUrl: source, mode: 'face', focus_x: 0 })
  assert.equal(edge.data?.focusX, 0)
  await assert.rejects(
    invoke('auto_reframe', {
      sourceUrl: source,
      mode: 'face',
      tracking: { frames: [{ time: 0, faces: [] }] },
    }),
    /未检测到有效人脸/,
  )
})
test('audio extraction prepares a real 16kHz mono PCM WAV for speech recognition', async () => {
  const extracted = await invoke('audio_mixer', {
    sourceUrls: [source],
    operation: 'extract_audio',
    sample_rate: 16000,
    channels: 1,
  })
  const metadata = inspect(extracted.files[0].path)
  const stream = metadata.streams.find((item) => item.codec_type === 'audio')!
  assert.equal(stream.channels, 1)
  assert.equal((stream as unknown as { sample_rate: string }).sample_rate, '16000')
})
test('local tools reject URL traversal, remote input, cross-project media and output symlinks', async () => {
  for (const sourceUrl of [
    'https://example.com/a.mp4',
    '/static/uploads/../source.mp4',
    '/etc/passwd',
    '/static/uploads/source.mp4?x=1',
  ])
    await assert.rejects(invoke('audio_probe', { sourceUrl }), /本地素材/)
  await fs.mkdir(path.join(root, 'creative', '2'), { recursive: true })
  await fs.copyFile(path.join(uploads, 'source.mp4'), path.join(root, 'creative', '2', 'source.mp4'))
  await assert.rejects(
    invoke('audio_probe', { sourceUrl: '/static/creative/2/source.mp4' }),
    /只能使用当前项目/,
  )
  await fs.mkdir(jobs, { recursive: true })
  const outside = path.join(directory, 'outside')
  await fs.mkdir(outside)
  await fs.symlink(outside, path.join(jobs, String(counter + 1)))
  await assert.rejects(invoke('audio_probe', { sourceUrl: source }), /输出目录必须/)
})
test('abort is respected before starting subprocesses', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(invoke('audio_probe', { sourceUrl: source }, controller.signal))
})
test('probe and scene detection inspect real uploaded media', async () => {
  const metadata = await invoke('audio_probe', { sourceUrl: source })
  assert.ok((metadata.data?.streams as unknown[]).length >= 2)
  const detected = await invoke('scene_detect', {
    sourceUrl: source,
    threshold: 0.1,
    min_scene_length_seconds: 0.2,
  })
  const scenes = detected.data?.scenes as { start_seconds: number; end_seconds: number }[]
  assert.equal(scenes.length, 2)
  assert.ok(Math.abs(scenes[0].end_seconds - 1) < 0.1)
})
test('frame sampling and quality checks return actual images and failed expectations', async () => {
  const sampled = await invoke('frame_sampler', { sourceUrl: source, count: 3 })
  assert.equal(sampled.files.filter((f) => f.kind === 'image').length, 3)
  const first = await sharp(sampled.files.find((f) => f.kind === 'image')!.path).metadata()
  assert.equal(first.width, 1280)
  const qa = await invoke('visual_qa', {
    sourceUrl: source,
    operation: 'probe',
    expected: { width: 999, has_audio: true },
  })
  assert.equal(qa.data?.passed, false)
  assert.deepEqual(qa.data?.checks, { width: false, has_audio: true })
})
test('audio energy analyzes PCM and identifies active music windows', async () => {
  const measured = await invoke('audio_energy', {
    sourceUrl: audio,
    interval: 0.25,
    video_duration_seconds: 0.5,
  })
  const profile = measured.data?.profile as { dbfs: number }[]
  assert.ok(profile.length >= 8)
  assert.ok(profile[0].dbfs > profile[4].dbfs + 20)
  assert.equal(measured.data?.loopRecommended, false)
})
test('analysis rejects overlong audio before allocating PCM, and vector artifacts stay confined', async () => {
  execFileSync(
    ffmpegPath || 'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=1000:cl=mono',
      '-t',
      '3601',
      '-c:a',
      'pcm_u8',
      path.join(uploads, 'long.wav'),
    ],
    { timeout: 30000 },
  )
  await assert.rejects(invoke('audio_energy', { sourceUrl: '/static/uploads/long.wav' }), /超过 60 分钟/)
  await fs.writeFile(
    path.join(uploads, 'unsafe.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><image href="http://127.0.0.1/private"/></svg>',
  )
  await assert.rejects(invoke('upscale', { sourceUrl: '/static/uploads/unsafe.svg' }), /外部资源/)
  await fs.writeFile(
    path.join(uploads, 'safe.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>',
  )
  const scaled = await invoke('upscale', { sourceUrl: '/static/uploads/safe.svg', scale: 2 })
  assert.equal((await sharp(scaled.files[0].path).metadata()).width, 40)
  await fs.writeFile(path.join(root, 'creative', '2', 'private.json'), '{}')
  await assert.rejects(
    invoke('export_bundle', { sourceUrls: ['/static/creative/2/private.json'] }),
    /只能读取当前项目/,
  )
  await fs.symlink(path.join(root, 'creative', '2', 'private.json'), path.join(uploads, 'aliased.json'))
  await assert.rejects(invoke('export_bundle', { sourceUrls: ['/static/uploads/aliased.json'] }), /符号链接/)
})
test('trim and speed encode valid shortened media', async () => {
  const trimmed = await invoke('video_trimmer', {
    sourceUrl: source,
    start_seconds: 0.2,
    end_seconds: 1.8,
    speed_factor: 2,
  })
  const metadata = inspect(trimmed.files[0].path)
  assert.ok(Number(metadata.format.duration) >= 0.75 && Number(metadata.format.duration) < 1.05)
  const slow = await invoke('video_trimmer', {
    sourceUrl: source,
    start_seconds: 0,
    end_seconds: 1,
    speed_factor: 0.5,
  })
  assert.ok(Number(inspect(slow.files[0].path).format.duration) >= 1.95)
  await assert.rejects(
    invoke('video_trimmer', { sourceUrl: source, start_seconds: 1.5, end_seconds: 1 }),
    /结束时间须大于/,
  )
})
test('stitch normalizes media, preserves audio and supports crossfades and spatial layout', async () => {
  const merged = await invoke('video_stitch', { sourceUrls: [source, source], width: 160, height: 90 })
  const metadata = inspect(merged.files[0].path)
  assert.ok(Number(metadata.format.duration) >= 4)
  assert.ok(metadata.streams.some((s) => s.codec_type === 'audio'))
  const faded = await invoke('video_stitch', {
    sourceUrls: [source, source],
    width: 160,
    height: 90,
    transition: 'crossfade',
    transition_duration: 0.4,
  })
  assert.ok(Number(inspect(faded.files[0].path).format.duration) < 3.8)
  const spatial = await invoke('video_stitch', {
    sourceUrls: [source, source],
    width: 160,
    height: 90,
    operation: 'spatial',
    layout: 'side_by_side',
  })
  assert.equal(inspect(spatial.files[0].path).streams.find((s) => s.codec_type === 'video')?.width, 320)
})
test('composition assembles images, video, captions and music into a decodable film', async () => {
  const composed = await invoke('video_compose', {
      sourceUrls: [image, source],
      clip_durations: [1],
      width: 160,
      height: 90,
      segments: [{ start: 0, end: 0.8, text: 'Opening' }],
      musicUrl: audio,
      music_volume: 0.2,
    }),
    metadata = inspect(composed.files[0].path)
  assert.ok(Number(metadata.format.duration) >= 3)
  assert.ok(metadata.streams.some((stream) => stream.codec_type === 'audio'))
})
test('silence cutting produces shorter synchronized video', async () => {
  const detected = await invoke('silence_cutter', {
    sourceUrl: source,
    operation: 'detect',
    threshold_db: -40,
    min_silence_seconds: 0.2,
  })
  assert.ok(Number(detected.data?.keptDuration) < 1.2)
  const cut = await invoke('silence_cutter', {
    sourceUrl: source,
    threshold_db: -40,
    min_silence_seconds: 0.2,
  })
  assert.ok(Number(inspect(cut.files[0].path).format.duration) < 1.3)
})
test('mixing, sidechain ducking and enhancement return decodable audio', async () => {
  for (const operation of ['mix', 'duck', 'fade']) {
    const mixed = await invoke('audio_mixer', { sourceUrls: [audio, audio], operation, volumes: [1, 0.2] })
    assert.equal(inspect(mixed.files[0].path).streams[0].codec_type, 'audio')
  }
  const enhanced = await invoke('audio_enhance', { sourceUrl: audio, preset: 'speech' })
  assert.ok(Number(inspect(enhanced.files[0].path).format.duration) >= 2)
})
test('subtitle files escape embedded tags, enforce monotonic cues and burn real video captions', async () => {
  const segments = [
    { start: 0, end: 0.8, text: '<script>hello</script>' },
    { start: 1, end: 1.8, text: 'world' },
  ]
  const vtt = await invoke('subtitle_gen', { segments, format: 'vtt' })
  const body = await fs.readFile(vtt.files[0].path, 'utf8')
  assert.ok(body.startsWith('WEBVTT'))
  assert.ok(!body.includes('<script>'))
  await assert.rejects(
    invoke('subtitle_gen', {
      segments: [
        { start: 1, end: 2, text: 'a' },
        { start: 1.5, end: 2.5, text: 'b' },
      ],
    }),
    /时间重叠/,
  )
  const burned = await invoke('remotion_caption_burn', { sourceUrl: source, segments })
  assert.ok(Number(inspect(burned.files[0].path).format.duration) >= 2)
  const url =
    '/static/' +
    path
      .relative(await fs.realpath(root), vtt.files[0].path)
      .split(path.sep)
      .join('/')
  const converted = await invoke('subtitle_gen', { subtitleUrl: url, format: 'srt' })
  assert.match(await fs.readFile(converted.files[0].path, 'utf8'), /00:00:00,800/)
  const fileBurned = await invoke('remotion_caption_burn', { sourceUrl: source, subtitleUrl: url })
  assert.ok(Number(inspect(fileBurned.files[0].path).format.duration) >= 2)
})
test('reframing, green screen alpha and compositing create real video streams', async () => {
  const reframed = await invoke('auto_reframe', { sourceUrl: source, aspect_ratio: '1:1' })
  assert.equal(inspect(reframed.files[0].path).streams.find((s) => s.codec_type === 'video')?.width, 720)
  const alpha = await invoke('green_screen_processor', { sourceUrl: source, key_color: '#ff0000' })
  assert.equal(path.extname(alpha.files[0].path), '.mov')
  const composite = await invoke('green_screen_composite', {
    sourceUrl: source,
    backgroundUrl: image,
    key_color: '#ff0000',
    width: 160,
    height: 90,
  })
  assert.equal(inspect(composite.files[0].path).streams.find((s) => s.codec_type === 'video')?.width, 160)
})
test('upscale, color grade and explicit retouching modify actual pixel outputs', async () => {
  const upscaled = await invoke('upscale', { sourceUrl: image, scale: 2 })
  assert.equal((await sharp(upscaled.files[0].path).metadata()).width, 320)
  const graded = await invoke('color_grade', { sourceUrl: image, preset: 'monochrome' })
  const pixel = await sharp(graded.files[0].path).raw().toBuffer()
  assert.equal(pixel[0], pixel[1])
  assert.equal(pixel[1], pixel[2])
  for (const toolId of ['face_enhance', 'eye_enhance']) {
    const enhanced = await invoke(toolId, {
      sourceUrl: image,
      regions: [{ x: 10, y: 10, width: 40, height: 40 }],
    })
    assert.equal((await sharp(enhanced.files[0].path).metadata()).width, 160)
  }
  await assert.rejects(invoke('eye_enhance', { sourceUrl: image }), /regions/)
})
test('diagram and code card render escaped vector text to PNG', async () => {
  const diagram = await invoke('diagram_gen', {
    title: 'A & B',
    width: 640,
    height: 360,
    boxes: [{ label: '<start>' }, { label: 'end' }],
    connections: [{ from: 0, to: 1 }],
  })
  assert.equal((await sharp(diagram.files[0].path).metadata()).width, 640)
  assert.ok((await fs.readFile(diagram.files[1].path, 'utf8')).includes('&lt;start&gt;'))
  const card = await invoke('code_snippet', {
    code: 'const name = "hello";\nreturn name;',
    width: 640,
    height: 360,
  })
  assert.equal((await sharp(card.files[0].path).metadata()).height, 360)
  const mermaid = await invoke('diagram_gen', {
    definition: 'flowchart LR\nA[Start] -->|next| B[End]',
    width: 640,
    height: 360,
  })
  assert.equal(mermaid.data?.nodes, 2)
  assert.equal(mermaid.data?.connections, 1)
})
test('mathematical expression parser rejects arbitrary code and renders animation', async () => {
  assert.equal(compileExpression('x^2+sin(pi/2)')(3, 0), 10)
  assert.ok(Math.abs(compileExpression('sin(x+t)')(0, Math.PI / 2) - 1) < 0.0001)
  for (const invalid of ['process.exit()', 'x.constructor', 'x;1', 'sin(x', 'x=>x'])
    assert.throws(() => compileExpression(invalid))
  const video = await invoke('math_animate', {
    expression: 'sin(x+t)',
    width: 320,
    height: 180,
    duration_seconds: 0.5,
    fps: 4,
  })
  assert.ok(Number(inspect(video.files[0].path).format.duration) >= 0.5)
})
test('character rig, poses, timeline and renderer form an executable animation sequence', async () => {
  const design = await invoke('character_spec_generator', {
      characters: [{ id: 'guide', name: 'Guide', color: '#73a4ff' }],
    }),
    rig = await invoke('svg_rig_builder', { character_design: design.data }),
    poses = await invoke('pose_library_builder', { rig_plan: rig.data })
  assert.ok(poses.data?.poses)
  const timeline = await invoke('action_timeline_compiler', {
      scene_plan: { actions: [{ characterId: 'guide', start: 0, end: 1, pose: 'walk', x: 0.2, toX: 0.8 }] },
    }),
    review = await invoke('character_animation_reviewer', {
      rig_plan: rig.data,
      action_timeline: timeline.data,
    })
  assert.equal(review.data?.passed, true)
  const animation = await invoke('character_rig_renderer', {
    rig_plan: rig.data,
    action_timeline: timeline.data,
    width: 320,
    height: 180,
    duration_seconds: 0.5,
    fps: 4,
  })
  assert.equal(animation.files[0].kind, 'video')
  assert.ok(Number(inspect(animation.files[0].path).format.duration) >= 0.5)
})
test('export bundles contain real source bytes and a ZIP central directory', async () => {
  const exported = await invoke('export_bundle', { sourceUrls: [source, image], title: 'test export' }),
    bytes = await fs.readFile(exported.files[0].path)
  assert.equal(bytes.readUInt32LE(0), 0x04034b50)
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50)
  assert.equal(bytes.readUInt16LE(bytes.length - 12), 3)
  assert.ok(bytes.includes(await fs.readFile(path.join(uploads, 'image.png'))))
  const outputDir = path.dirname(exported.files[0].path)
  await fs.writeFile(exported.files[0].path, 'partial interrupted output')
  const resumed = await runLocalTool({
    projectId: 1,
    toolId: 'export_bundle',
    args: { sourceUrls: [source], title: 'resumed' },
    outputDir,
    signal: new AbortController().signal,
    progress() {},
  })
  assert.equal((await fs.readFile(resumed.files[0].path)).readUInt32LE(0), 0x04034b50)
})
test('Three.js outputs a real self-contained runtime package and validates camera data', async () => {
  assert.equal((await localToolAvailability('threejs_world')).available, true)
  const world = await invoke('threejs_world', {
    world_spec: {
      objects: [{ type: 'box', color: '#ff8844', size: 2 }],
      camera_path: [
        { x: 8, y: 5, z: 8 },
        { x: -8, y: 5, z: 8 },
      ],
    },
  })
  const bytes = await fs.readFile(world.files[0].path)
  for (const name of [
    'world.html',
    'world.js',
    'world.json',
    'three.module.js',
    'three.core.js',
    'LICENSE.txt',
  ])
    assert.ok(bytes.includes(Buffer.from(name)))
  assert.ok(bytes.includes(Buffer.from('WebGLRenderer')))
  assert.equal(world.data?.runtime, 'threejs')
  await assert.rejects(invoke('threejs_world', { world_spec: { objects: [{ type: 'unknown' }] } }), /仅支持/)
})
test('missing heavy runtimes give actionable dependency status and no fake outputs', async () => {
  const previous = process.env.BLENDER_BIN
  process.env.BLENDER_BIN = path.join(directory, 'does-not-exist')
  const status = await localToolAvailability('blender_world')
  assert.equal(status.available, false)
  assert.match(status.reason!, /Blender/)
  await assert.rejects(invoke('blender_world', { world_spec: { objects: [{ type: 'box' }] } }), /BLENDER_BIN/)
  if (previous === undefined) delete process.env.BLENDER_BIN
  else process.env.BLENDER_BIN = previous
})
