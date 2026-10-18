/** Local creative-video composition. Media never leaves the configured storage root. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { checkFfmpegSuite, ffmpegPath, ffprobePath } from '../utils/ffmpeg.js'
import { STORAGE_ROOT } from '../utils/paths.js'

export interface CreativeRenderInput {
  projectId: number
  aspectRatio: '16:9' | '9:16' | '1:1'
  title: string
  shots: Array<{
    id: string
    title: string
    duration: number
    mediaType: 'image' | 'video'
    imageUrl?: string | null
    videoUrl?: string | null
    caption: string
    trimStart?: number
    audioUrl?: string | null
    audioTrimStart?: number
    originalVolume?: number
  }>
  narrationUrl?: string | null
  musicUrl?: string | null
  musicVolume?: number
  burnSubtitles?: boolean
}

interface MediaProbe {
  format?: { duration?: string; format_name?: string }
  streams?: Array<{
    codec_type?: string
    codec_name?: string
    disposition?: { attached_pic?: number }
    width?: number
    height?: number
    duration?: string
    avg_frame_rate?: string
  }>
}

const FPS = 30
const DIMENSIONS = { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [720, 720] } as const
// Exclude playlist/concat/network demuxers when probing user uploads.
const INPUT_FORMATS =
  'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpegts,mpeg,mpegvideo,mp3,wav,aac,ogg,flac,png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,gif'
const SAFE_INPUT = ['-protocol_whitelist', 'file', '-format_whitelist', INPUT_FORMATS]
const ENCODE_VIDEO = [
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-crf',
  '20',
  '-pix_fmt',
  'yuv420p',
  '-threads',
  '2',
]

function positiveNumber(value: number, label: string, max: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > max)
    throw new Error(`${label}必须大于 0 且不超过 ${max}`)
}

function volume(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback
  if (!Number.isFinite(result) || result < 0 || result > 2) throw new Error(`${label}须在 0 到 2 之间`)
  return result
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  )
}

async function localMedia(root: string, url: string, label: string): Promise<string> {
  // /static/ is the public URL prefix, never an absolute filesystem path.
  if (url.startsWith('/static/')) url = url.slice(1)
  if (
    !url.startsWith('static/') ||
    /[\\\x00-\x1f%?#:]/.test(url) ||
    url.split('/').some((p) => !p || p === '.' || p === '..')
  ) {
    throw new Error(`${label}必须是已上传的本地 static/ 文件，不能使用外部链接或越界路径`)
  }
  const candidate = path.resolve(root, url.slice('static/'.length))
  if (!inside(root, candidate)) throw new Error(`${label}路径超出本地素材目录`)
  let real: string
  try {
    real = await fs.realpath(candidate)
  } catch {
    throw new Error(`${label}文件不存在，请重新上传或生成`)
  }
  if (!inside(root, real)) throw new Error(`${label}不能通过符号链接访问素材目录之外的文件`)
  if (!(await fs.stat(real)).isFile()) throw new Error(`${label}必须是普通文件`)
  return real
}

async function storageDirectory(root: string, name: string): Promise<string> {
  const dir = path.join(root, name)
  await fs.mkdir(dir, { recursive: true })
  const real = await fs.realpath(dir)
  if (!inside(root, real)) throw new Error('导出目录不能指向素材目录之外')
  return real
}

/** Each subprocess is bounded; no shell, arbitrary FFmpeg options, or remote inputs. */
function run(
  binary: string,
  args: string[],
  options: {
    cwd?: string
    timeoutMs?: number
    duration?: number
    onProgress?: (fraction: number) => void
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let progressBuffer = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs ?? 30_000)
    child.stdout.on('data', (buffer: Buffer) => {
      const chunk = buffer.toString()
      stdout = (stdout + chunk).slice(-2_000_000)
      if (!options.onProgress || !options.duration) return
      progressBuffer += chunk
      const lines = progressBuffer.split('\n')
      progressBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const match = /^out_time_us=(\d+)/.exec(line)
        if (match) options.onProgress(Math.min(1, Number(match[1]) / 1_000_000 / options.duration))
      }
    })
    child.stderr.on('data', (buffer: Buffer) => {
      stderr = (stderr + buffer.toString()).slice(-16_000)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`无法启动视频处理程序：${error.message}`))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error('视频处理超时，请缩短视频或检查本机资源后重试'))
      else if (code !== 0)
        reject(new Error(`视频处理失败：${stderr.trim().slice(-3000) || `退出码 ${code}`}`))
      else resolve(stdout)
    })
  })
}

async function probe(file: string, binary: string): Promise<MediaProbe> {
  const output = await run(binary, [
    '-v',
    'error',
    ...SAFE_INPUT,
    '-show_format',
    '-show_streams',
    '-of',
    'json',
    file,
  ])
  try {
    return JSON.parse(output) as MediaProbe
  } catch {
    throw new Error('无法读取素材的媒体信息')
  }
}

function mediaDuration(probe: MediaProbe, type?: 'audio' | 'video'): number {
  const stream = type ? probe.streams?.find((s) => s.codec_type === type) : undefined
  return Number(stream?.duration ?? probe.format?.duration ?? 0)
}

function captionLines(text: string, width: number): string[] {
  // Plain text only: do not let uploaded text inject ASS/SRT positioning or style tags.
  const clean = text
    .replace(/\{[^}]*\}|<[^>]*>/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/\\/g, '／')
  const lines: string[] = []
  for (const paragraph of clean.split(/\r?\n/)) {
    let line = ''
    let used = 0
    for (const character of Array.from(paragraph.trim())) {
      const weight = /[\u0000-\u00ff]/.test(character) ? 1 : 2
      if (used + weight > width && line) {
        lines.push(line.trim())
        line = ''
        used = 0
      }
      line += character
      used += weight
    }
    if (line.trim()) lines.push(line.trim())
  }
  return lines
}

function srtTime(seconds: number): string {
  const milliseconds = Math.round(seconds * 1000)
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds / 60_000) % 60
  const secs = Math.floor(milliseconds / 1000) % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(milliseconds % 1000).padStart(3, '0')}`
}

function subtitles(
  shots: CreativeRenderInput['shots'],
  aspectRatio: CreativeRenderInput['aspectRatio'],
): string {
  const cues: string[] = []
  let cursor = 0
  for (const shot of shots) {
    const lines = captionLines(
      shot.caption ?? '',
      aspectRatio === '9:16' ? 28 : aspectRatio === '1:1' ? 32 : 48,
    )
    const pages: string[] = []
    for (let i = 0; i < lines.length; i += 2) pages.push(lines.slice(i, i + 2).join('\n'))
    pages.forEach((page, i) =>
      cues.push(
        `${cues.length + 1}\n${srtTime(cursor + (shot.duration * i) / pages.length)} --> ${srtTime(cursor + (shot.duration * (i + 1)) / pages.length)}\n${page}\n`,
      ),
    )
    cursor += shot.duration
  }
  return cues.join('\n')
}

async function captionFont(): Promise<{ file: string; family: string } | null> {
  const candidates = [
    {
      file: process.env.CREATIVE_SUBTITLE_FONT ?? '',
      family: process.env.CREATIVE_SUBTITLE_FONT_FAMILY ?? 'sans-serif',
    },
    { file: '/System/Library/Fonts/PingFang.ttc', family: 'PingFang SC' },
    { file: '/System/Library/Fonts/STHeiti Medium.ttc', family: 'Heiti SC' },
    { file: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', family: 'Noto Sans CJK SC' },
    { file: '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc', family: 'Noto Sans CJK SC' },
    { file: path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'msyh.ttc'), family: 'Microsoft YaHei' },
  ]
  for (const candidate of candidates) {
    if (!candidate.file) continue
    try {
      if ((await fs.stat(candidate.file)).isFile()) return candidate
    } catch {
      /* try next installed font */
    }
  }
  return null
}

/** Produces a frame-aligned movie, preserving original audio unless its volume is zero. */
export async function renderCreativeVideo(
  input: CreativeRenderInput,
  onProgress?: (percent: number) => void,
): Promise<{
  videoUrl: string
  subtitleUrl: string | null
  duration: number
  width: number
  height: number
  warnings: string[]
}> {
  if (!Number.isSafeInteger(input.projectId) || input.projectId <= 0) throw new Error('项目编号无效')
  if (!Object.hasOwn(DIMENSIONS, input.aspectRatio)) throw new Error('不支持的画面比例')
  if (!Array.isArray(input.shots) || !input.shots.length || input.shots.length > 200)
    throw new Error('请添加 1 至 200 个画面后再导出')
  const warnings: string[] = []
  let elapsed = 0,
    alignedFrames = 0
  const shots = input.shots.map((shot, index) => {
    positiveNumber(shot.duration, `画面 ${index + 1} 的时长`, 600)
    if (shot.duration < 1 / FPS) throw new Error(`画面 ${index + 1} 的时长不能少于一帧`)
    if (!['image', 'video'].includes(shot.mediaType)) throw new Error(`画面 ${index + 1} 的素材类型无效`)
    if (typeof shot.caption !== 'string' || shot.caption.length > 5000)
      throw new Error(`画面 ${index + 1} 的字幕不能超过 5000 个字符`)
    const trimStart = shot.trimStart ?? 0
    if (!Number.isFinite(trimStart) || trimStart < 0) throw new Error(`画面 ${index + 1} 的裁剪起点无效`)
    elapsed += shot.duration
    const nextFrames = Math.round(elapsed * FPS)
    const alignedDuration = (nextFrames - alignedFrames) / FPS
    alignedFrames = nextFrames
    return {
      ...shot,
      trimStart,
      duration: alignedDuration,
      originalVolume: volume(shot.originalVolume, 1, '原声音量'),
    }
  })
  const total = shots.reduce((sum, shot) => sum + shot.duration, 0)
  positiveNumber(total, '成片总时长', 3600)
  const musicVolume = volume(input.musicVolume, 0.2, '配乐音量')
  const [width, height] = DIMENSIONS[input.aspectRatio]
  if (shots.some((shot, i) => Math.abs(shot.duration - input.shots[i].duration) > 0.0001))
    warnings.push('画面边界已对齐到 30 帧/秒，时序误差控制在一帧内。')
  const suite = await checkFfmpegSuite()
  if (!suite.ffmpeg || !suite.ffprobe || !ffmpegPath || !ffprobePath)
    throw new Error('FFmpeg / FFprobe 不可用，请配置有效的视频处理程序后重试')
  const renderBinary = ffmpegPath
  const probeBinary = ffprobePath
  await fs.mkdir(STORAGE_ROOT, { recursive: true })
  const storage = await fs.realpath(STORAGE_ROOT)
  const renderRoot = await storageDirectory(storage, 'creative')
  const outputDir = await storageDirectory(storage, `creative/${input.projectId}`)
  const work = await fs.mkdtemp(path.join(renderRoot, '.render-'))
  const runId = randomUUID()
  const outputVideo = path.join(outputDir, `${runId}.mp4`)
  const outputSrt = path.join(outputDir, `${runId}.srt`)
  const started = Date.now()
  const configuredTimeout = Number(process.env.CREATIVE_RENDER_TIMEOUT_MS ?? 1_800_000)
  const timeout = Number.isFinite(configuredTimeout)
    ? Math.max(30_000, Math.min(configuredTimeout, 7_200_000))
    : 1_800_000
  let lastProgress = -1
  const progress = (value: number) => {
    const bounded = Math.max(lastProgress, Math.min(100, Math.max(0, Math.floor(value))))
    if (bounded !== lastProgress) {
      lastProgress = bounded
      try {
        onProgress?.(bounded)
      } catch {
        /* progress observers cannot abort a render */
      }
    }
  }
  const render = (args: string[], duration: number, update?: (fraction: number) => void) => {
    const remaining = timeout - (Date.now() - started)
    if (remaining <= 0) throw new Error('视频导出超时，请缩短视频后重试')
    return run(
      renderBinary,
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-progress', 'pipe:1', ...args],
      {
        cwd: work,
        timeoutMs: remaining,
        duration,
        onProgress: update,
      },
    )
  }
  try {
    progress(1)
    const srt = subtitles(shots, input.aspectRatio)
    await fs.writeFile(path.join(work, 'captions.srt'), srt, 'utf8')
    let subtitleFilter: string | undefined
    if (input.burnSubtitles && srt) {
      const filters = await run(renderBinary, ['-hide_banner', '-filters'])
      if (!/\bsubtitles\s+V->V/.test(filters))
        throw new Error('当前 FFmpeg 不支持字幕烧录，请关闭“烧录字幕”下载 SRT，或安装带 libass 的 FFmpeg')
      const font = await captionFont()
      if (!font)
        throw new Error('未找到可用于字幕的中文字体，请配置 CREATIVE_SUBTITLE_FONT，或关闭“烧录字幕”导出 SRT')
      await fs.mkdir(path.join(work, 'fonts'))
      await fs.copyFile(font.file, path.join(work, 'fonts', `subtitle${path.extname(font.file)}`))
      const family = font.family.replace(/[^\p{L}\p{N} _-]/gu, '')
      subtitleFilter = `subtitles=filename=captions.srt:fontsdir=fonts:force_style='FontName=${family},FontSize=${input.aspectRatio === '9:16' ? 8 : 14},Outline=1.5,Shadow=0,MarginV=24,Alignment=2'`
    }

    const extras: Array<{ kind: 'narration' | 'music'; file: string; duration: number }> = []
    for (const [kind, url] of [
      ['narration', input.narrationUrl],
      ['music', input.musicUrl],
    ] as const) {
      if (!url) continue
      const label = kind === 'narration' ? '旁白' : '配乐'
      const file = await localMedia(storage, url, label)
      const metadata = await probe(file, probeBinary)
      if (!metadata.streams?.some((stream) => stream.codec_type === 'audio'))
        throw new Error(`${label}文件不包含音轨`)
      const duration = mediaDuration(metadata, 'audio')
      if (!Number.isFinite(duration) || duration <= 0) throw new Error(`${label}文件没有有效时长`)
      if (kind === 'narration' && duration > total + 0.1)
        throw new Error(
          `旁白长于成片（${duration.toFixed(1)} 秒 / ${total.toFixed(1)} 秒），请延长画面或缩短旁白，避免截断语句`,
        )
      extras.push({ kind, file, duration })
    }

    let completedDuration = 0
    for (let index = 0; index < shots.length; index++) {
      const shot = shots[index]
      const label = `画面 ${index + 1}「${shot.title || shot.id}」`
      const url = shot.mediaType === 'video' ? shot.videoUrl : shot.imageUrl
      if (!url)
        throw new Error(
          `${label}尚未${shot.mediaType === 'video' ? '提供视频' : '提供图片'}，请选择已有素材后再导出`,
        )
      const media = await localMedia(storage, url, label)
      const metadata = await probe(media, probeBinary)
      const video = metadata.streams?.find((stream) => stream.codec_type === 'video')
      if (!video?.width || !video.height) throw new Error(`${label}没有可用画面`)
      const isStill = /(?:png|jpeg|webp|bmp)_pipe|^gif$/.test(metadata.format?.format_name ?? '')
      if (shot.mediaType === 'image' && !isStill)
        throw new Error(`${label}需要图片文件，请将视频素材的类型设为视频`)
      if (shot.mediaType === 'video' && isStill) throw new Error(`${label}需要视频文件，不能用静态图片代替`)
      const inputOptions =
        shot.mediaType === 'image'
          ? [
              '-protocol_whitelist',
              'file',
              '-f',
              'image2',
              '-pattern_type',
              'none',
              '-loop',
              '1',
              '-framerate',
              String(FPS),
            ]
          : [...SAFE_INPUT]
      if (shot.mediaType === 'video') {
        const duration = mediaDuration(metadata, 'video')
        if (!Number.isFinite(duration) || duration <= 0) throw new Error(`${label}无法读取视频时长`)
        if (shot.trimStart + shot.duration > duration + 1 / FPS)
          throw new Error(
            `${label}可用视频时长不足：裁剪起点 ${shot.trimStart.toFixed(2)} 秒，加上画面时长 ${shot.duration.toFixed(2)} 秒，超过视频 ${duration.toFixed(2)} 秒。请缩短画面或更换素材`,
          )
        inputOptions.push('-ss', String(shot.trimStart))
      }
      let hasAudio =
        shot.mediaType === 'video' && metadata.streams?.some((stream) => stream.codec_type === 'audio')
      const args = [...inputOptions, '-i', media]
      let audioMap = hasAudio ? '0:a:0' : '1:a:0'
      if (shot.audioUrl) {
        const audio = await localMedia(storage, shot.audioUrl, `${label}声音`)
        const audioInfo = await probe(audio, probeBinary)
        const start = shot.audioTrimStart ?? 0
        if (
          !Number.isFinite(start) ||
          start < 0 ||
          !audioInfo.streams?.some((s) => s.codec_type === 'audio') ||
          start + shot.duration > mediaDuration(audioInfo, 'audio') + 1 / FPS
        ) {
          throw new Error(`${label}的音频选段超出素材时长`)
        }
        args.push(...SAFE_INPUT, '-ss', String(start), '-i', audio)
        hasAudio = true
        audioMap = '1:a:0'
      }
      if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo')
      const videoFilter = `setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS},tpad=stop_mode=clone:stop_duration=0.04,trim=duration=${shot.duration}`
      args.push(
        '-map',
        '0:v:0',
        '-map',
        audioMap,
        '-vf',
        videoFilter,
        '-af',
        `aresample=48000,asetpts=PTS-STARTPTS,volume=${shot.audioUrl ? 1 : hasAudio ? shot.originalVolume : 0},apad,atrim=duration=${shot.duration}`,
        '-t',
        String(shot.duration),
        ...ENCODE_VIDEO,
        '-c:a',
        'pcm_s16le',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-map_metadata',
        '-1',
        `shot-${index}.mkv`,
      )
      await render(args, shot.duration, (fraction) =>
        progress(5 + ((completedDuration + shot.duration * fraction) / total) * 65),
      )
      completedDuration += shot.duration
      progress(5 + (completedDuration / total) * 65)
    }

    // Generated names contain no user text; relative concat entries avoid quoting user paths.
    await fs.writeFile(
      path.join(work, 'clips.txt'),
      shots.map((_, index) => `file 'shot-${index}.mkv'`).join('\n'),
    )
    const args = ['-f', 'concat', '-safe', '1', '-protocol_whitelist', 'file', '-i', 'clips.txt']
    for (const extra of extras) {
      args.push(...SAFE_INPUT, '-i', extra.file)
    }
    const audioFilters = [`[0:a:0]aresample=48000,apad,atrim=duration=${total},asetpts=PTS-STARTPTS[a0]`]
    extras.forEach((extra, index) => {
      const music = extra.kind === 'music'
      const fade = Math.min(1, total / 4)
      const fill =
        music && extra.duration < total ? `aloop=loop=-1:size=${Math.ceil(extra.duration * 48000)}` : 'apad'
      audioFilters.push(
        `[${index + 1}:a:0]aresample=48000,aformat=channel_layouts=stereo,${fill},atrim=duration=${total},asetpts=PTS-STARTPTS,volume=${music ? musicVolume : 1}${music ? `,afade=t=in:d=${fade},afade=t=out:st=${total - fade}:d=${fade}` : ''}[a${index + 1}]`,
      )
    })
    audioFilters.push(
      `${Array.from({ length: extras.length + 1 }, (_, i) => `[a${i}]`).join('')}amix=inputs=${extras.length + 1}:duration=longest:normalize=0,alimiter=limit=0.95:level=false:latency=true,atrim=duration=${total}[mixed]`,
    )
    args.push('-filter_complex', audioFilters.join(';'), '-map', '0:v:0', '-map', '[mixed]')
    if (subtitleFilter) args.push('-vf', subtitleFilter, ...ENCODE_VIDEO)
    else args.push('-c:v', 'copy')
    args.push(
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-t',
      String(total),
      '-map_metadata',
      '-1',
      '-metadata',
      `title=${input.title.slice(0, 200)}`,
      '-movflags',
      '+faststart',
      'final.mp4',
    )
    await render(args, total, (fraction) => progress(70 + fraction * 27))
    const metadata = await probe(path.join(work, 'final.mp4'), probeBinary)
    const video = metadata.streams?.find((stream) => stream.codec_type === 'video')
    const duration = mediaDuration(metadata)
    if (
      video?.width !== width ||
      video.height !== height ||
      video.codec_name !== 'h264' ||
      !metadata.streams?.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac')
    ) {
      throw new Error('成片校验失败：画面尺寸或音视频编码不符合导出要求')
    }
    if (!Number.isFinite(duration) || Math.abs(duration - total) > Math.max(0.15, shots.length * 0.002))
      throw new Error(`成片时长校验失败：预期 ${total.toFixed(2)} 秒，实际 ${duration.toFixed(2)} 秒`)
    await fs.rename(path.join(work, 'final.mp4'), outputVideo)
    await fs.rename(path.join(work, 'captions.srt'), outputSrt)
    progress(100)
    return {
      videoUrl: `static/creative/${input.projectId}/${runId}.mp4`,
      subtitleUrl: `static/creative/${input.projectId}/${runId}.srt`,
      duration,
      width,
      height,
      warnings,
    }
  } catch (error) {
    await Promise.allSettled([fs.rm(outputVideo, { force: true }), fs.rm(outputSrt, { force: true })])
    throw error
  } finally {
    await fs.rm(work, { recursive: true, force: true })
  }
}

/** Reads uploaded media safely; audio receives a reusable waveform cover for podcast edits. */
export async function inspectCreativeSource(projectId: number, url: string, createCover = true) {
  const suite = await checkFfmpegSuite()
  if (!suite.ffprobe || !suite.ffmpeg || !ffprobePath || !ffmpegPath)
    throw new Error('FFmpeg / FFprobe 不可用')
  const root = await fs.realpath(STORAGE_ROOT)
  const file = await localMedia(root, url, '原始素材')
  const metadata = await probe(file, ffprobePath)
  const video = metadata.streams?.find(
    (stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic,
  )
  const still = /(?:png|jpeg|webp|bmp)_pipe|^gif$/.test(metadata.format?.format_name ?? '')
  const kind = still ? ('image' as const) : video ? ('video' as const) : ('audio' as const)
  const duration = still ? null : mediaDuration(metadata)
  if (!still && (!Number.isFinite(duration) || !duration || duration > 86400))
    throw new Error('无法读取素材时长，或素材超过24小时')
  if (kind === 'audio' && !metadata.streams?.some((stream) => stream.codec_type === 'audio'))
    throw new Error('素材没有可用音轨')
  let coverUrl: string | null = null
  if (kind === 'audio' && createCover) {
    const folder = await storageDirectory(root, `creative/${projectId}`)
    const filename = `wave-${randomUUID()}.png`
    try {
      await run(
        ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-y',
          ...SAFE_INPUT,
          '-t',
          '120',
          '-i',
          file,
          '-filter_complex',
          'aformat=channel_layouts=mono,showwavespic=s=1280x720:colors=0x6f94ff',
          '-frames:v',
          '1',
          path.join(folder, filename),
        ],
        { timeoutMs: 60000 },
      )
    } catch (error) {
      await fs.rm(path.join(folder, filename), { force: true })
      throw error
    }
    coverUrl = `/static/creative/${projectId}/${filename}`
  }
  return { kind, duration, coverUrl }
}
