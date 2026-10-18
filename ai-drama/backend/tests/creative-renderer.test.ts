import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'

// Configure storage before importing the service: these tests never touch user data.
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-render-test-'))
process.env.HUOBAO_DATA_DIR = fixture
process.env.STORAGE_PATH = path.join(fixture, 'static')
const { renderCreativeVideo } = await import('../src/services/creative-renderer.js')
const { checkFfmpegSuite, ffmpegPath, ffprobePath } = await import('../src/utils/ffmpeg.js')
const suite = await checkFfmpegSuite()
const canRender = suite.ffmpeg && suite.ffprobe && !!ffmpegPath && !!ffprobePath
const exec = promisify(execFile)
const uploads = path.join(fixture, 'static', 'uploads')
const base = {
  projectId: 7,
  title: '创意视频测试',
  aspectRatio: '16:9' as const,
  shots: [
    {
      id: 'image',
      title: '图片',
      mediaType: 'image' as const,
      imageUrl: 'static/uploads/image.png',
      duration: 0.6,
      caption: '这是创意视频的字幕测试',
    },
  ],
}

before(async () => {
  await fs.mkdir(uploads, { recursive: true })
  await sharp({ create: { width: 160, height: 90, channels: 3, background: '#315fa0' } })
    .png()
    .toFile(path.join(uploads, 'image.png'))
  if (!canRender) return
  const run = (args: string[]) =>
    exec(ffmpegPath!, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: 30_000 })
  await run([
    '-f',
    'lavfi',
    '-i',
    'color=c=orange:s=160x90:r=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    '1.2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    path.join(uploads, 'video.mp4'),
  ])
  await run([
    '-f',
    'lavfi',
    '-i',
    'color=c=green:s=90x160:r=30',
    '-t',
    '0.6',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-an',
    path.join(uploads, 'silent.mp4'),
  ])
  await run([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:sample_rate=48000',
    '-t',
    '0.8',
    path.join(uploads, 'voice.wav'),
  ])
  await run([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:sample_rate=48000',
    '-t',
    '0.4',
    path.join(uploads, 'music.wav'),
  ])
})
after(async () => {
  await fs.rm(fixture, { recursive: true, force: true })
})

test(
  'renders mixed images, trimmed video, silent video and mixed sound to validated H.264/AAC',
  { skip: !canRender, timeout: 120_000 },
  async () => {
    const progress: number[] = []
    const result = await renderCreativeVideo(
      {
        ...base,
        shots: [
          ...base.shots,
          {
            id: 'video',
            title: '视频',
            mediaType: 'video',
            videoUrl: '/static/uploads/video.mp4',
            duration: 0.6,
            trimStart: 0.3,
            originalVolume: 0.4,
            caption: '带原声的视频',
          },
          {
            id: 'silent',
            title: '无声视频',
            mediaType: 'video',
            videoUrl: 'static/uploads/silent.mp4',
            duration: 0.6,
            caption: '无声素材也能参与合成',
          },
        ],
        narrationUrl: '/static/uploads/voice.wav',
        musicUrl: 'static/uploads/music.wav',
        musicVolume: 0.15,
      },
      (value) => progress.push(value),
    )
    assert.equal(result.width, 1280)
    assert.equal(result.height, 720)
    assert.ok(Math.abs(result.duration - 1.8) < 0.15)
    assert.match(result.videoUrl, /^static\/creative\/7\/[^/]+\.mp4$/)
    assert.ok(result.subtitleUrl)
    const srt = await fs.readFile(path.join(fixture, result.subtitleUrl!), 'utf8')
    assert.match(srt, /00:00:00,600 --> 00:00:01,200/)
    assert.match(srt, /带原声的视频/)
    const metadata = JSON.parse(
      (
        await exec(ffprobePath!, [
          '-v',
          'error',
          '-show_streams',
          '-of',
          'json',
          path.join(fixture, result.videoUrl),
        ])
      ).stdout,
    )
    assert.ok(metadata.streams.some((stream: { codec_name: string }) => stream.codec_name === 'aac'))
    assert.equal(
      metadata.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video').avg_frame_rate,
      '30/1',
    )
    const { stdout: pcm } = await exec(
      ffmpegPath!,
      [
        '-v',
        'error',
        '-i',
        path.join(fixture, result.videoUrl),
        '-t',
        '0.3',
        '-vn',
        '-ac',
        '1',
        '-ar',
        '8000',
        '-f',
        's16le',
        'pipe:1',
      ],
      { encoding: 'buffer' },
    )
    let energy = 0
    for (let offset = 0; offset + 1 < pcm.length; offset += 2) energy += pcm.readInt16LE(offset) ** 2
    assert.ok(
      Math.sqrt(energy / (pcm.length / 2)) > 100,
      'narration and music must be audible, not just an empty audio stream',
    )
    assert.equal(progress.at(-1), 100)
    assert.deepEqual(
      progress,
      [...new Set(progress)].sort((a, b) => a - b),
    )
    assert.ok(progress.every((value) => value >= 0 && value <= 100))
    assert.ok(
      !(await fs.readdir(path.join(fixture, 'static', 'creative'))).some((name) =>
        name.startsWith('.render-'),
      ),
    )
  },
)

test(
  'renders portrait and square layouts and keeps SRT available without burn-in',
  { skip: !canRender, timeout: 120_000 },
  async () => {
    for (const aspectRatio of ['9:16', '1:1'] as const) {
      const result = await renderCreativeVideo({ ...base, aspectRatio })
      assert.equal(result.width, 720)
      assert.equal(result.height, aspectRatio === '9:16' ? 1280 : 720)
      assert.ok((await fs.stat(path.join(fixture, result.subtitleUrl!))).size > 0)
    }
  },
)

test(
  'muting original video sound keeps replacement shot narration audible',
  { skip: !canRender },
  async () => {
    const result = await renderCreativeVideo({
      ...base,
      shots: [
        {
          id: 'dubbed',
          title: '替换配音',
          mediaType: 'video',
          videoUrl: '/static/uploads/video.mp4',
          audioUrl: '/static/uploads/voice.wav',
          duration: 0.5,
          originalVolume: 0,
          caption: '新配音',
        },
      ],
    })
    const { stdout: pcm } = await exec(
      ffmpegPath!,
      [
        '-v',
        'error',
        '-i',
        path.join(fixture, result.videoUrl),
        '-vn',
        '-ac',
        '1',
        '-ar',
        '8000',
        '-f',
        's16le',
        'pipe:1',
      ],
      { encoding: 'buffer' },
    )
    let energy = 0
    for (let i = 0; i + 1 < pcm.length; i += 2) energy += pcm.readInt16LE(i) ** 2
    assert.ok(
      Math.sqrt(energy / (pcm.length / 2)) > 100,
      'replacement narration must remain audible when originalVolume is zero',
    )
  },
)

test(
  'burns Chinese subtitles when libass and a supported font are installed',
  { skip: !canRender, timeout: 120_000 },
  async (t) => {
    try {
      const result = await renderCreativeVideo({ ...base, burnSubtitles: true })
      assert.ok((await fs.stat(path.join(fixture, result.videoUrl))).size > 0)
      const { stdout: frame } = await exec(
        ffmpegPath!,
        [
          '-v',
          'error',
          '-ss',
          '0.3',
          '-i',
          path.join(fixture, result.videoUrl),
          '-frames:v',
          '1',
          '-f',
          'image2pipe',
          '-vcodec',
          'png',
          'pipe:1',
        ],
        { encoding: 'buffer', maxBuffer: 2_000_000 },
      )
      const pixels = await sharp(frame).removeAlpha().raw().toBuffer()
      let brightPixels = 0
      for (let i = 0; i < pixels.length; i += 3)
        if (pixels[i] > 220 && pixels[i + 1] > 220 && pixels[i + 2] > 220) brightPixels++
      assert.ok(brightPixels > 100, 'white subtitle glyphs must appear in the rendered frame')
    } catch (error) {
      if (/不支持字幕烧录|未找到可用于字幕的中文字体/.test((error as Error).message)) {
        t.skip((error as Error).message)
        return
      }
      throw error
    }
  },
)

test(
  'rejects network, absolute, encoded and symlink-escaping media URLs',
  { skip: !canRender, timeout: 120_000 },
  async () => {
    const outside = path.join(fixture, 'outside.png')
    await fs.copyFile(path.join(uploads, 'image.png'), outside)
    await fs.symlink(outside, path.join(uploads, 'escape.png'))
    for (const imageUrl of [
      'https://example.com/image.png',
      '/etc/passwd',
      'static/../outside.png',
      'static/uploads/%2e%2e/image.png',
      'static/uploads/escape.png',
    ]) {
      await assert.rejects(
        renderCreativeVideo({ ...base, shots: [{ ...base.shots[0], imageUrl }] }),
        /本地 static|符号链接|路径/,
      )
    }
  },
)

test(
  'rejects missing video, a still image passed as video and insufficient source duration',
  { skip: !canRender, timeout: 120_000 },
  async () => {
    await assert.rejects(
      renderCreativeVideo({ ...base, shots: [{ ...base.shots[0], mediaType: 'video' }] }),
      /尚未提供视频/,
    )
    await assert.rejects(
      renderCreativeVideo({
        ...base,
        shots: [{ ...base.shots[0], mediaType: 'video', videoUrl: base.shots[0].imageUrl }],
      }),
      /需要视频文件/,
    )
    await assert.rejects(
      renderCreativeVideo({
        ...base,
        shots: [
          { ...base.shots[0], mediaType: 'video', videoUrl: 'static/uploads/video.mp4', trimStart: 0.9 },
        ],
      }),
      /可用视频时长不足/,
    )
    await assert.rejects(
      renderCreativeVideo({ ...base, narrationUrl: 'static/uploads/voice.wav' }),
      /旁白长于成片/,
    )
    const folders = await fs.readdir(path.join(fixture, 'static', 'creative'))
    assert.ok(!folders.some((name) => name.startsWith('.render-')))
  },
)

test('rejects invalid durations and volumes before rendering', async () => {
  await assert.rejects(renderCreativeVideo({ ...base, shots: [{ ...base.shots[0], duration: NaN }] }), /时长/)
  await assert.rejects(
    renderCreativeVideo({ ...base, shots: [{ ...base.shots[0], duration: 0.001 }] }),
    /一帧/,
  )
  await assert.rejects(renderCreativeVideo({ ...base, musicVolume: 3 }), /配乐音量/)
})

test(
  'audio imports receive a waveform cover and trimmed podcast audio remains audible',
  { skip: !canRender, timeout: 120000 },
  async () => {
    const { inspectCreativeSource } = await import('../src/services/creative-renderer.js')
    const info = await inspectCreativeSource(7, '/static/uploads/voice.wav')
    assert.equal(info.kind, 'audio')
    assert.ok(info.duration! >= 0.8)
    assert.ok(info.coverUrl)
    const image = await sharp(path.join(fixture, info.coverUrl!.slice(1))).metadata()
    assert.equal(image.width, 1280)
    assert.equal(image.height, 720)
    const result = await renderCreativeVideo({
      ...base,
      shots: [
        {
          ...base.shots[0],
          imageUrl: info.coverUrl!,
          audioUrl: '/static/uploads/voice.wav',
          audioTrimStart: 0.2,
          duration: 0.5,
        },
      ],
    })
    const { stdout: pcm } = await exec(
      ffmpegPath!,
      [
        '-v',
        'error',
        '-i',
        path.join(fixture, result.videoUrl),
        '-t',
        '0.4',
        '-vn',
        '-ac',
        '1',
        '-ar',
        '8000',
        '-f',
        's16le',
        'pipe:1',
      ],
      { encoding: 'buffer' },
    )
    let energy = 0
    for (let i = 0; i + 1 < pcm.length; i += 2) energy += pcm.readInt16LE(i) ** 2
    assert.ok(Math.sqrt(energy / (pcm.length / 2)) > 100)
    await assert.rejects(
      renderCreativeVideo({
        ...base,
        shots: [{ ...base.shots[0], audioUrl: '/static/uploads/voice.wav', audioTrimStart: 0.6 }],
      }),
      /音频选段超出/,
    )
    assert.equal((await inspectCreativeSource(7, '/static/uploads/image.png')).kind, 'image')
    assert.equal((await inspectCreativeSource(7, '/static/uploads/video.mp4')).kind, 'video')
  },
)
