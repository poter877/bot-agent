import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import {
  ENCODE,
  SAFE_INPUT,
  asset,
  choice,
  dimensions,
  duration,
  ffmpeg,
  inferKind,
  inputUrl,
  jsonResult,
  list,
  media,
  normalizeVideo,
  num,
  object,
  output,
  probe,
  result,
  run,
  str,
} from './local-core.js'
import type { LocalContext, LocalDependencies, ToolResult } from './local-core.js'
import { parseCreativeSrt } from '../creative-sources.js'

function sources(args: Record<string, unknown>) {
  const values = args.sourceUrls ?? args.clips ?? args.input_paths
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length > 30 ||
    values.some((v) => typeof v !== 'string')
  )
    throw new Error('请选择 1 至 30 个已上传的素材')
  return values as string[]
}
function atempo(speed: number) {
  const values: number[] = []
  while (speed > 2) {
    values.push(2)
    speed /= 2
  }
  while (speed < 0.5) {
    values.push(0.5)
    speed /= 0.5
  }
  values.push(speed)
  return values.map((v) => `atempo=${v}`).join(',')
}
function filterEscape(file: string) {
  return file.replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:')
}

export async function audioEnergy(ctx: LocalContext, deps: LocalDependencies, file: string) {
  const info = await probe(ctx, deps, file),
    seconds = duration(info)
  if (!info.streams?.some((s) => s.codec_type === 'audio')) throw new Error('素材中没有音轨')
  const pcm = await run(
    ctx,
    deps.ffmpeg,
    [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      ...SAFE_INPUT,
      '-i',
      file,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '8000',
      '-t',
      String(seconds),
      '-f',
      's16le',
      'pipe:1',
    ],
    { timeout: 180000, maxBuffer: 60 * 1024 * 1024 },
  )
  const bins: { start: number; end: number; rms: number; dbfs: number }[] = []
  const interval = num(ctx.args, 'interval', 0.5, 0.1, 10),
    size = Math.round(interval * 8000)
  for (let start = 0; start < pcm.length / 2; start += size) {
    const count = Math.min(size, pcm.length / 2 - start)
    let sum = 0
    for (let i = 0; i < count; i++) {
      const value = pcm.readInt16LE((start + i) * 2) / 32768
      sum += value * value
    }
    const rms = Math.sqrt(sum / count)
    bins.push({
      start: start / 8000,
      end: (start + count) / 8000,
      rms,
      dbfs: rms ? 20 * Math.log10(rms) : -120,
    })
  }
  const requested = num(ctx.args, 'video_duration_seconds', Math.min(seconds, 30), 0.1, 3600),
    windowSize = Math.max(1, Math.round(requested / interval))
  let best = 0,
    bestSum = -1,
    sum = 0
  for (let i = 0; i < bins.length; i++) {
    sum += bins[i].rms
    if (i >= windowSize) sum -= bins[i - windowSize].rms
    if (i >= windowSize - 1 && sum > bestSum) {
      bestSum = sum
      best = i - windowSize + 1
    }
  }
  const beats = bins
    .filter(
      (b, i) =>
        i > 0 &&
        i < bins.length - 1 &&
        b.rms > bins[i - 1].rms * 1.25 &&
        b.rms >= bins[i + 1].rms &&
        b.dbfs > -40,
    )
    .map((b) => b.start)
  return {
    duration: seconds,
    profile: bins,
    bestWindow: { start: bins[best]?.start ?? 0, duration: Math.min(requested, seconds) },
    loopRecommended: requested > seconds,
    beats,
  }
}

async function scenes(ctx: LocalContext, deps: LocalDependencies, file: string) {
  const seconds = duration(await probe(ctx, deps, file)),
    rawThreshold = num(ctx.args, 'threshold', 0.3, 0.01, 100),
    threshold = rawThreshold > 1 ? rawThreshold / 100 : rawThreshold
  // Metadata output is a generated file. The filter never receives user text or paths.
  const metadata = output(ctx, 'scene-metadata.txt')
  await ffmpeg(ctx, deps, [
    ...SAFE_INPUT,
    '-i',
    file,
    '-an',
    '-vf',
    `select='gt(scene,${threshold})',metadata=print:file='${filterEscape(metadata)}'`,
    '-vsync',
    'vfr',
    '-f',
    'null',
    '-',
  ])
  const text = await fs.readFile(metadata, 'utf8').catch(() => '')
  const minimum = num(ctx.args, 'min_scene_length_seconds', 0.5, 0.1, 120),
    times = [0]
  for (const match of text.matchAll(/pts_time:([\d.]+)/g)) {
    const time = Number(match[1])
    if (time - times[times.length - 1] >= minimum && seconds - time >= minimum) times.push(time)
  }
  times.push(seconds)
  return times
    .slice(0, -1)
    .map((start, i) => ({ start_seconds: start, end_seconds: times[i + 1], duration: times[i + 1] - start }))
}

async function frames(ctx: LocalContext, deps: LocalDependencies, file: string) {
  const seconds = duration(await probe(ctx, deps, file)),
    maximum = Math.round(num(ctx.args, 'max_frames', 20, 1, 50))
  let timestamps: number[]
  const strategy = choice(
    ctx.args,
    'strategy',
    ['count', 'interval', 'timestamps', 'scene_guided'] as const,
    'count',
  )
  if (strategy === 'timestamps' || ctx.args.timestamps)
    timestamps = list(ctx.args, 'timestamps', 50).map((v) => {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v >= seconds)
        throw new Error('抽帧时间超出素材时长')
      return v
    })
  else if (strategy === 'interval') {
    const interval = num(ctx.args, 'interval_seconds', 5, 0.1, 3600)
    timestamps = Array.from(
      { length: Math.min(maximum, Math.ceil(seconds / interval)) },
      (_, i) => i * interval,
    )
  } else if (strategy === 'scene_guided')
    timestamps = (await scenes(ctx, deps, file))
      .slice(0, maximum)
      .map((s) => (s.start_seconds + s.end_seconds) / 2)
  else {
    const count = Math.round(num(ctx.args, 'count', 8, 1, maximum))
    timestamps = Array.from({ length: count }, (_, i) =>
      Math.min(seconds - 0.02, (seconds * (i + 0.5)) / count),
    )
  }
  if (!timestamps.length) throw new Error('请至少提供一个抽帧时间')
  const format = choice(ctx.args, 'format', ['png', 'jpg'] as const, 'jpg'),
    names: Array<[string, 'image']> = []
  for (let i = 0; i < timestamps.length; i++) {
    const name = `frame-${String(i + 1).padStart(3, '0')}.${format}`
    await ffmpeg(
      ctx,
      deps,
      [
        '-ss',
        String(timestamps[i]),
        ...SAFE_INPUT,
        '-i',
        file,
        '-frames:v',
        '1',
        '-vf',
        'scale=1280:1280:force_original_aspect_ratio=decrease',
        output(ctx, name),
      ],
      60000,
    )
    names.push([name, 'image'])
    ctx.progress(((i + 1) / timestamps.length) * 0.9)
  }
  return { names, timestamps }
}

async function stitch(ctx: LocalContext, deps: LocalDependencies): Promise<ToolResult> {
  const urls = sources(ctx.args),
    kinds = urls.map((url) => (ctx.args.allowImages === true ? inferKind(url) : ('video' as const))),
    paths = await Promise.all(urls.map((url, index) => media(ctx, deps, url, kinds[index]))),
    infos = await Promise.all(paths.map((file) => probe(ctx, deps, file))),
    clipDurations = list(ctx.args, 'clip_durations', 30)
  if (kinds.includes('audio')) throw new Error('画面合成需要图片或视频，音频请放入配乐或混音工具')
  if (ctx.args.operation === 'validate')
    return jsonResult(ctx, '已检查全部片段', {
      clips: infos.map((info, i) => ({ sourceUrl: urls[i], ...info })),
      valid: infos.every((i) => i.streams?.some((s) => s.codec_type === 'video')),
    })
  const { width, height } = dimensions(ctx.args),
    operation = choice(ctx.args, 'operation', ['stitch', 'preview_stitch', 'spatial'] as const, 'stitch'),
    transition = choice(ctx.args, 'transition', ['cut', 'crossfade', 'fade'] as const, 'cut')
  const segments: string[] = [],
    lengths: number[] = []
  for (let i = 0; i < paths.length; i++) {
    const rawLength =
        kinds[i] === 'image' ? num({ value: clipDurations[i] }, 'value', 3, 0.1, 600) : duration(infos[i]),
      length = operation === 'preview_stitch' ? Math.min(rawLength, 3) : rawLength
    lengths.push(length)
    const hasAudio = infos[i].streams?.some((s) => s.codec_type === 'audio'),
      name = `normalized-${i}.mp4`,
      file = output(ctx, name)
    await ffmpeg(ctx, deps, [
      ...(kinds[i] === 'image' ? ['-loop', '1', '-framerate', '30'] : []),
      ...SAFE_INPUT,
      '-i',
      paths[i],
      ...(!hasAudio ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'] : []),
      '-map',
      '0:v:0',
      '-map',
      hasAudio ? '0:a:0' : '1:a:0',
      '-t',
      String(length),
      '-vf',
      normalizeVideo(width, height),
      '-af',
      'aresample=48000',
      ...ENCODE,
      '-c:a',
      'aac',
      '-ac',
      '2',
      file,
    ])
    segments.push(file)
    ctx.progress(((i + 1) / paths.length) * 0.5)
  }
  if (lengths.reduce((a, b) => a + b, 0) > 3600) throw new Error('合并后的视频超过 60 分钟')
  const destination = output(ctx, 'video.mp4')
  if (operation === 'spatial') {
    if (segments.length !== 2) throw new Error('空间合成须选择两个片段')
    const layout = choice(
      ctx.args,
      'layout',
      ['side_by_side', 'vertical_stack', 'picture_in_picture'] as const,
      'side_by_side',
    )
    const filter =
      layout === 'picture_in_picture'
        ? `[1:v]scale=${Math.round(width / 3 / 2) * 2}:-2[pip];[0:v][pip]overlay=W-w-24:H-h-24[v]`
        : layout === 'vertical_stack'
          ? '[0:v][1:v]vstack=inputs=2[v]'
          : '[0:v][1:v]hstack=inputs=2[v]'
    await ffmpeg(
      ctx,
      deps,
      segments
        .flatMap((file) => [...SAFE_INPUT, '-i', file])
        .concat([
          '-filter_complex',
          filter,
          '-map',
          '[v]',
          '-map',
          '0:a',
          '-t',
          String(Math.min(...lengths)),
          ...ENCODE,
          '-c:a',
          'aac',
          destination,
        ]),
    )
  } else if (transition === 'cut' || segments.length === 1) {
    // Generated relative names only; concat file never embeds uploaded paths.
    const manifest = output(ctx, 'concat.txt')
    await fs.writeFile(manifest, segments.map((file) => `file '${path.basename(file)}'`).join('\n'))
    await ffmpeg(ctx, deps, [
      '-protocol_whitelist',
      'file',
      '-f',
      'concat',
      '-safe',
      '1',
      '-i',
      manifest,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      destination,
    ])
  } else {
    const fade = num(ctx.args, 'transition_duration', 0.5, 0.1, Math.min(3, ...lengths.map((v) => v / 2))),
      filters: string[] = []
    let offset = lengths[0]
    for (let i = 1; i < segments.length; i++) {
      const previousV = i === 1 ? '0:v' : `v${i - 1}`,
        previousA = i === 1 ? '0:a' : `a${i - 1}`
      offset -= fade
      filters.push(
        `[${previousV}][${i}:v]xfade=transition=${transition === 'fade' ? 'fadeblack' : 'fade'}:duration=${fade}:offset=${offset}[v${i}]`,
        `[${previousA}][${i}:a]acrossfade=d=${fade}[a${i}]`,
      )
      offset += lengths[i]
    }
    await ffmpeg(ctx, deps, [
      ...segments.flatMap((file) => [...SAFE_INPUT, '-i', file]),
      '-filter_complex',
      filters.join(';'),
      '-map',
      `[v${segments.length - 1}]`,
      '-map',
      `[a${segments.length - 1}]`,
      ...ENCODE,
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      destination,
    ])
  }
  return result(ctx, '片段合成完成', [['video.mp4', 'video']], { clips: paths.length, transition })
}

async function trim(ctx: LocalContext, deps: LocalDependencies) {
  if (ctx.args.operation === 'concat')
    return stitch({ ...ctx, args: { ...ctx.args, operation: 'stitch' } }, deps)
  const file = await media(ctx, deps),
    info = await probe(ctx, deps, file),
    seconds = duration(info),
    start = num(ctx.args, 'start_seconds', num(ctx.args, 'start', 0), 0, seconds),
    end = num(ctx.args, 'end_seconds', num(ctx.args, 'end', seconds), 0, seconds)
  if (end <= start) throw new Error('结束时间须大于开始时间')
  const speed = num(ctx.args, 'speed_factor', num(ctx.args, 'speed', 1, 0.1, 100), 0.1, 100),
    audioOnly = !info.streams?.some((s) => s.codec_type === 'video'),
    name = audioOnly ? 'audio.wav' : 'video.mp4'
  const args = ['-ss', String(start), '-t', String(end - start), ...SAFE_INPUT, '-i', file]
  if (audioOnly) args.push('-vn', '-af', atempo(speed), '-c:a', 'pcm_s16le')
  else {
    args.push('-vf', `setpts=PTS/${speed}`, ...ENCODE)
    if (info.streams?.some((s) => s.codec_type === 'audio')) args.push('-af', atempo(speed), '-c:a', 'aac')
  }
  await ffmpeg(ctx, deps, [...args, output(ctx, name)])
  return result(ctx, '裁剪与变速完成', [[name, audioOnly ? 'audio' : 'video']], {
    start,
    end,
    speed,
    duration: (end - start) / speed,
  })
}

async function mix(ctx: LocalContext, deps: LocalDependencies) {
  const operation = choice(
    ctx.args,
    'operation',
    ['mix', 'duck', 'fade', 'normalize', 'extract_audio', 'segmented_music'] as const,
    'mix',
  )
  const urls = ctx.args.sourceUrls || ctx.args.input_paths ? sources(ctx.args) : [inputUrl(ctx.args)],
    files = await Promise.all(urls.map((url) => media(ctx, deps, url)))
  if (operation === 'extract_audio') {
    await ffmpeg(ctx, deps, [
      ...SAFE_INPUT,
      '-i',
      files[0],
      '-vn',
      '-c:a',
      'pcm_s16le',
      '-ar',
      String(Math.round(num(ctx.args, 'sample_rate', 48000, 8000, 96000))),
      '-ac',
      String(Math.round(num(ctx.args, 'channels', 2, 1, 2))),
      output(ctx, 'audio.wav'),
    ])
    return result(ctx, '已提取音轨', [['audio.wav', 'audio']])
  }
  const infos = await Promise.all(files.map((file) => probe(ctx, deps, file)))
  for (const info of infos)
    if (!info.streams?.some((s) => s.codec_type === 'audio')) throw new Error('有素材没有音轨')
  const seconds = Math.max(...infos.map(duration)),
    filters: string[] = [],
    volumes = list(ctx.args, 'volumes', 30)
  for (let i = 0; i < files.length; i++) {
    const volume = volumes[i] ?? 1
    if (typeof volume !== 'number' || volume < 0 || volume > 4 || !Number.isFinite(volume))
      throw new Error('混音音量须在 0 至 4 之间')
    filters.push(`[${i}:a]aresample=48000,volume=${volume}[a${i}]`)
  }
  if (operation === 'duck') {
    if (files.length !== 2) throw new Error('自动压低背景音乐须提供旁白和音乐两条音轨')
    filters.push(
      '[a0]asplit=2[voice][side];[a1][side]sidechaincompress=threshold=0.025:ratio=8:attack=10:release=300[bg]',
      '[voice][bg]amix=inputs=2:normalize=0[mix]',
    )
  } else if (files.length > 1)
    filters.push(
      `${files.map((_, i) => `[a${i}]`).join('')}amix=inputs=${files.length}:duration=longest:normalize=0[mix]`,
    )
  else filters.push('[a0]anull[mix]')
  const fade = num(ctx.args, 'fade_seconds', 0.5, 0, Math.min(10, seconds / 2)),
    tail = operation === 'fade' ? `afade=t=in:d=${fade},afade=t=out:st=${seconds - fade}:d=${fade},` : ''
  filters.push(`[mix]${tail}loudnorm=I=-16:TP=-1.5:LRA=11[out]`)
  await ffmpeg(ctx, deps, [
    ...files.flatMap((file) => [...SAFE_INPUT, '-i', file]),
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[out]',
    '-t',
    String(Math.min(seconds, 3600)),
    '-c:a',
    'pcm_s16le',
    output(ctx, 'audio.wav'),
  ])
  return result(ctx, '混音完成', [['audio.wav', 'audio']], { tracks: files.length, operation })
}

async function audioEnhance(ctx: LocalContext, deps: LocalDependencies) {
  const file = await media(ctx, deps),
    preset = choice(ctx.args, 'preset', ['speech', 'music', 'normalize', 'denoise'] as const, 'speech'),
    noise = num(ctx.args, 'noise_reduction', 12, 0.01, 50),
    target = num(ctx.args, 'target_lufs', -16, -30, -9)
  const filters =
    preset === 'speech'
      ? `highpass=f=80,lowpass=f=14000,afftdn=nr=${noise},acompressor=threshold=0.1:ratio=3:attack=10:release=100`
      : preset === 'denoise'
        ? `afftdn=nr=${noise}`
        : 'anull'
  await ffmpeg(ctx, deps, [
    ...SAFE_INPUT,
    '-i',
    file,
    '-vn',
    '-af',
    `${filters},loudnorm=I=${target}:TP=-1.5:LRA=11`,
    '-c:a',
    'pcm_s16le',
    '-ar',
    '48000',
    output(ctx, 'audio.wav'),
  ])
  return result(ctx, '音频清理与响度处理完成', [['audio.wav', 'audio']], { preset, targetLufs: target })
}

function timestamp(seconds: number, vtt = false) {
  const ms = Math.round(seconds * 1000)
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}${vtt ? '.' : ','}${String(ms % 1000).padStart(3, '0')}`
}
async function captionEntries(ctx: LocalContext, deps?: LocalDependencies) {
  const entries = list(ctx.args, 'segments', 2000)
  if (entries.length || !ctx.args.subtitleUrl) return entries
  if (!deps) throw new Error('字幕读取缺少本地文件服务')
  const source = await asset(ctx, deps, str(ctx.args, 'subtitleUrl'), ['.srt', '.vtt'])
  if ((await fs.stat(source)).size > 300000) throw new Error('字幕文件过大，请拆分到 10 万字符以内')
  let body = await fs.readFile(source, 'utf8')
  if (source.endsWith('.vtt'))
    body = body
      .replace(/^\uFEFF?WEBVTT[^\n]*\n+/, '')
      .replace(/^(?:NOTE|STYLE|REGION)[\s\S]*?(?:\n\n|$)/gm, '')
      .replace(/^(\d{1,2}:\d{2}\.\d{3})\s*-->\s*(\d{1,2}:\d{2}\.\d{3}).*$/gm, '00:$1 --> 00:$2')
      .replace(/^(\d{2,}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2,}:\d{2}:\d{2}[,.]\d{3}).*$/gm, '$1 --> $2')
  return parseCreativeSrt(body).map((cue) => ({ start: cue.start, end: cue.end, text: cue.caption }))
}
export async function subtitles(ctx: LocalContext, deps?: LocalDependencies) {
  const entries = await captionEntries(ctx, deps),
    format = choice(ctx.args, 'format', ['srt', 'vtt', 'json'] as const, 'srt'),
    width = Math.round(num(ctx.args, 'max_chars_per_line', 42, 8, 120)),
    corrections = ctx.args.corrections ? object(ctx.args.corrections) : {}
  if (!entries.length) throw new Error('请提供带起止时间的字幕片段')
  let previous = 0
  const cues = entries.map((entry, index) => {
    const cue = object(entry, '字幕片段'),
      start = num(cue, 'start', 0),
      end = num(cue, 'end', 0),
      raw = str(cue, 'text', str(cue, 'caption', ''), 3000).replace(/<[^>]*>|\{[^}]*\}/g, '')
    if (end <= start || start < previous || !raw.trim())
      throw new Error(`第 ${index + 1} 条字幕时间重叠或内容为空`)
    previous = end
    let text = raw
    for (const [from, to] of Object.entries(corrections)) {
      if (!from || from.length > 100 || typeof to !== 'string' || to.length > 200)
        throw new Error('字幕修正词表无效')
      text = text.split(from).join(to)
    }
    const lines: string[] = []
    for (const paragraph of text.split('\n')) {
      const chars = Array.from(paragraph)
      for (let i = 0; i < chars.length; i += width) lines.push(chars.slice(i, i + width).join(''))
    }
    return { start, end, text: lines.join('\n') }
  })
  const name = `subtitles.${format}`,
    body =
      format === 'json'
        ? JSON.stringify(cues, null, 2)
        : (format === 'vtt' ? 'WEBVTT\n\n' : '') +
          cues
            .map(
              (cue, i) =>
                `${i + 1}\n${timestamp(cue.start, format === 'vtt')} --> ${timestamp(cue.end, format === 'vtt')}\n${cue.text}`,
            )
            .join('\n\n') +
          '\n'
  await fs.writeFile(output(ctx, name), body)
  return result(ctx, '字幕文件生成完成', [[name, 'subtitle']], { count: cues.length, format })
}

async function captionBurn(ctx: LocalContext, deps: LocalDependencies) {
  const source = await media(ctx, deps, inputUrl(ctx.args), 'video')
  await subtitles({ ...ctx, args: { ...ctx.args, format: 'srt' } }, deps)
  const fontSize = Math.round(num(ctx.args, 'font_size', 26, 10, 72)),
    filter = `subtitles=filename='${filterEscape(output(ctx, 'subtitles.srt'))}':force_style='FontSize=${fontSize},MarginV=32,Outline=2'`
  await ffmpeg(ctx, deps, [
    ...SAFE_INPUT,
    '-i',
    source,
    '-vf',
    filter,
    ...ENCODE,
    '-c:a',
    'copy',
    '-movflags',
    '+faststart',
    output(ctx, 'video.mp4'),
  ])
  return result(ctx, '字幕已烧录到视频', [
    ['video.mp4', 'video'],
    ['subtitles.srt', 'subtitle'],
  ])
}

async function silenceCut(ctx: LocalContext, deps: LocalDependencies) {
  const source = await media(ctx, deps),
    info = await probe(ctx, deps, source),
    seconds = duration(info),
    threshold = num(ctx.args, 'threshold_db', -35, -80, -10),
    minimum = num(ctx.args, 'min_silence_seconds', 0.4, 0.1, 10),
    log = output(ctx, 'silence.txt')
  if (!info.streams?.some((s) => s.codec_type === 'audio')) throw new Error('素材没有可检测的音轨')
  await ffmpeg(ctx, deps, [
    ...SAFE_INPUT,
    '-i',
    source,
    '-vn',
    '-af',
    `silencedetect=noise=${threshold}dB:d=${minimum},ametadata=print:file='${filterEscape(log)}'`,
    '-f',
    'null',
    '-',
  ])
  const text = await fs.readFile(log, 'utf8').catch(() => ''),
    starts = [...text.matchAll(/lavfi\.silence_start(?:\.\d+)?=([\d.]+)/g)].map((v) => Number(v[1])),
    ends = [...text.matchAll(/lavfi\.silence_end(?:\.\d+)?=([\d.]+)/g)].map((v) => Number(v[1])),
    ranges: { start: number; end: number }[] = []
  let cursor = 0
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] > cursor + 0.03) ranges.push({ start: cursor, end: starts[i] })
    cursor = ends.find((v) => v >= starts[i]) ?? seconds
  }
  if (cursor < seconds - 0.03) ranges.push({ start: cursor, end: seconds })
  if (!ranges.length) throw new Error('素材全部为静音，没有可保留的片段')
  if (ranges.length > 100) throw new Error('检测到超过 100 段，请提高最短静音时间后重试')
  if (ctx.args.operation === 'detect')
    return jsonResult(ctx, '静音区间检测完成', {
      ranges,
      originalDuration: seconds,
      keptDuration: ranges.reduce((v, r) => v + r.end - r.start, 0),
    })
  const video = info.streams.some((s) => s.codec_type === 'video'),
    filters = ranges.flatMap((range, i) => [
      ...(video ? [`[0:v]trim=start=${range.start}:end=${range.end},setpts=PTS-STARTPTS[v${i}]`] : []),
      `[0:a]atrim=start=${range.start}:end=${range.end},asetpts=PTS-STARTPTS[a${i}]`,
    ])
  filters.push(
    `${ranges.map((_, i) => `${video ? `[v${i}]` : ''}[a${i}]`).join('')}concat=n=${ranges.length}:v=${video ? 1 : 0}:a=1${video ? '[v]' : ''}[a]`,
  )
  const name = video ? 'video.mp4' : 'audio.wav'
  await ffmpeg(ctx, deps, [
    ...SAFE_INPUT,
    '-i',
    source,
    '-filter_complex',
    filters.join(';'),
    ...(video ? ['-map', '[v]', ...ENCODE] : []),
    '-map',
    '[a]',
    '-c:a',
    video ? 'aac' : 'pcm_s16le',
    output(ctx, name),
  ])
  return result(ctx, '静音片段已移除', [[name, video ? 'video' : 'audio']], {
    ranges,
    originalDuration: seconds,
    keptDuration: ranges.reduce((v, r) => v + r.end - r.start, 0),
  })
}

async function reframe(ctx: LocalContext, deps: LocalDependencies) {
  const source = await media(ctx, deps, inputUrl(ctx.args), 'video'),
    ratio = choice(ctx.args, 'aspect_ratio', ['16:9', '9:16', '1:1', '4:3'] as const, '9:16'),
    sizes = { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [720, 720], '4:3': [960, 720] },
    [width, height] = sizes[ratio],
    mode = choice(ctx.args, 'mode', ['center', 'pad', 'face'] as const, 'center')
  let trackedFocus: number | undefined
  if (mode === 'face' && ctx.args.tracking) {
    const frames = list(object(ctx.args.tracking), 'frames', 600)
    const positions = frames
      .flatMap((value) => {
        const faces = list(object(value), 'faces', 20)
          .map((face) => object(face))
          .filter(
            (face) =>
              typeof face.focus_x === 'number' &&
              Number.isFinite(face.focus_x) &&
              face.focus_x >= 0 &&
              face.focus_x <= 1,
          )
          .sort((a, b) => Number(b.width) * Number(b.height) - Number(a.width) * Number(a.height))
        return faces.length ? [Number(faces[0].focus_x)] : []
      })
      .sort((a, b) => a - b)
    if (!positions.length) throw new Error('人脸跟踪未检测到有效人脸，请检查原片或明确选择中心/留边构图')
    const middle = Math.floor(positions.length / 2)
    trackedFocus = positions.length % 2 ? positions[middle] : (positions[middle - 1] + positions[middle]) / 2
  }
  if (mode === 'face' && trackedFocus === undefined && ctx.args.focus_x == null)
    throw new Error('人脸跟踪重构请先运行人脸追踪，并提供 tracking 或 focus_x（0 至 1）')
  const focus = trackedFocus ?? num(ctx.args, 'focus_x', 0.5, 0, 1),
    cropX = mode === 'face' ? `'max(0,min(iw-ow,iw*${focus}-ow/2))'` : `(iw-ow)*${focus}`,
    base =
      mode === 'pad'
        ? normalizeVideo(width, height)
        : `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}:${cropX}:(ih-oh)/2,setsar=1,format=yuv420p`
  await ffmpeg(ctx, deps, [
    ...SAFE_INPUT,
    '-i',
    source,
    '-vf',
    base,
    ...ENCODE,
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    output(ctx, 'video.mp4'),
  ])
  return result(ctx, '画面比例调整完成', [['video.mp4', 'video']], {
    aspectRatio: ratio,
    mode,
    focusX: focus,
    tracked: trackedFocus !== undefined,
  })
}

async function chroma(ctx: LocalContext, deps: LocalDependencies) {
  const source = await media(ctx, deps, inputUrl(ctx.args), 'video'),
    color = str(ctx.args, 'key_color', '#00ff00', 7),
    similarity = num(ctx.args, 'similarity', 0.15, 0.01, 0.8),
    blend = num(ctx.args, 'blend', 0.08, 0, 1)
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('抠像颜色须为六位十六进制颜色')
  const backgroundUrl = str(ctx.args, 'backgroundUrl', str(ctx.args, 'background_path'))
  if (ctx.toolId === 'green_screen_composite' || backgroundUrl) {
    const background = await media(ctx, deps, backgroundUrl),
      size = dimensions(ctx.args),
      args = [
        ...SAFE_INPUT,
        '-i',
        source,
        ...(inferKind(backgroundUrl) === 'image' ? ['-loop', '1'] : []),
        ...SAFE_INPUT,
        '-i',
        background,
      ],
      seconds = duration(await probe(ctx, deps, source)),
      scale = num(ctx.args, 'foreground_scale', 1, 0.1, 1)
    const width = Math.round((size.width * scale) / 2) * 2,
      height = Math.round((size.height * scale) / 2) * 2
    await ffmpeg(ctx, deps, [
      ...args,
      '-filter_complex',
      `[0:v]${normalizeVideo(width, height)},format=rgba,colorkey=0x${color.slice(1)}:${similarity}:${blend}[fg];[1:v]${normalizeVideo(size.width, size.height)}[bg];[bg][fg]overlay=(W-w)/2:H-h:shortest=1[v]`,
      '-map',
      '[v]',
      '-map',
      '0:a?',
      '-t',
      String(seconds),
      ...ENCODE,
      '-c:a',
      'aac',
      output(ctx, 'video.mp4'),
    ])
    return result(ctx, '绿幕背景合成完成', [['video.mp4', 'video']])
  }
  await ffmpeg(ctx, deps, [
    ...SAFE_INPUT,
    '-i',
    source,
    '-vf',
    `format=rgba,colorkey=0x${color.slice(1)}:${similarity}:${blend}`,
    '-c:v',
    'qtrle',
    '-c:a',
    'pcm_s16le',
    output(ctx, 'alpha.mov'),
  ])
  return result(ctx, '已输出带透明通道的视频', [['alpha.mov', 'video']])
}

async function enhancement(ctx: LocalContext, deps: LocalDependencies) {
  const url = inputUrl(ctx.args),
    source = await media(ctx, deps, url),
    image = inferKind(url) === 'image',
    tool = ctx.toolId
  if (tool === 'upscale') {
    const factor = num(ctx.args, 'scale', 2, 1, 4)
    if (image) {
      const metadata = await sharp(source).metadata()
      if (
        !metadata.width ||
        !metadata.height ||
        metadata.width * metadata.height * factor * factor > 33554432
      )
        throw new Error('放大后的图像超过 3200 万像素')
      await sharp(source)
        .resize(Math.round(metadata.width * factor), Math.round(metadata.height * factor), {
          kernel: 'lanczos3',
        })
        .sharpen()
        .png()
        .toFile(output(ctx, 'image.png'))
      return result(ctx, '图像放大完成', [['image.png', 'image']], { method: 'lanczos3', factor })
    }
    const metadata = await probe(ctx, deps, source),
      stream = metadata.streams?.find((s) => s.codec_type === 'video')
    if (!stream?.width || !stream.height || stream.width * stream.height * factor * factor > 8294400)
      throw new Error('放大后的视频超过 4K 限制')
    await ffmpeg(ctx, deps, [
      ...SAFE_INPUT,
      '-i',
      source,
      '-vf',
      `scale=trunc(iw*${factor}/2)*2:trunc(ih*${factor}/2)*2:flags=lanczos,unsharp=5:5:0.5`,
      ...ENCODE,
      '-c:a',
      'copy',
      output(ctx, 'video.mp4'),
    ])
    return result(ctx, '视频放大完成', [['video.mp4', 'video']], { method: 'lanczos', factor })
  }
  if (tool === 'color_grade') {
    const preset = choice(
        ctx.args,
        'preset',
        ['neutral', 'cinematic', 'warm', 'cool', 'vintage', 'monochrome'] as const,
        'neutral',
      ),
      brightness = num(ctx.args, 'brightness', 0, -0.5, 0.5),
      contrast = num(ctx.args, 'contrast', 1, 0.5, 2),
      saturation = num(
        ctx.args,
        'saturation',
        preset === 'monochrome' ? 0 : preset === 'cinematic' ? 0.85 : 1,
        0,
        3,
      )
    if (image) {
      let pipeline = sharp(source)
        .modulate({ brightness: 1 + brightness, saturation })
        .linear(contrast, -(contrast - 1) * 128)
      if (preset === 'warm') pipeline = pipeline.tint('#f2d3ad')
      if (preset === 'cool') pipeline = pipeline.tint('#bbd7ef')
      if (preset === 'vintage') pipeline = pipeline.tint('#dec9a4')
      await pipeline.png().toFile(output(ctx, 'image.png'))
      return result(ctx, '图像调色完成', [['image.png', 'image']], { preset })
    }
    let filter = `eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}`
    if (preset === 'warm') filter += ',colorbalance=rs=0.08:bs=-0.06'
    if (preset === 'cool') filter += ',colorbalance=rs=-0.04:bs=0.08'
    if (preset === 'vintage') filter += ',colorbalance=rs=0.08:gs=0.03:bs=-0.08,curves=preset=vintage'
    if (preset === 'cinematic') filter += ',curves=preset=medium_contrast'
    await ffmpeg(ctx, deps, [
      ...SAFE_INPUT,
      '-i',
      source,
      '-vf',
      filter,
      ...ENCODE,
      '-c:a',
      'copy',
      output(ctx, 'video.mp4'),
    ])
    return result(ctx, '视频调色完成', [['video.mp4', 'video']], { preset })
  }
  // Face and eye retouching is restricted to explicit regions; it never claims an AI restoration.
  const regions = list(ctx.args, 'regions', 20),
    strength = num(ctx.args, 'strength', 0.35, 0, 1)
  if (!regions.length)
    throw new Error('请提供要处理的人脸或眼部 regions（x、y、width、height）；也可先运行人脸追踪获取位置')
  if (!image) throw new Error('局部人像增强目前接收图片，请先抽取帧或使用人脸修复视频适配器')
  const info = await sharp(source).metadata()
  if (!info.width || !info.height) throw new Error('无法读取图像尺寸')
  const layers = await Promise.all(
    regions.map(async (value) => {
      const region = object(value),
        x = Math.round(num(region, 'x', 0, 0, info.width!)),
        y = Math.round(num(region, 'y', 0, 0, info.height!)),
        width = Math.round(num(region, 'width', 0, 1, info.width! - x)),
        height = Math.round(num(region, 'height', 0, 1, info.height! - y))
      let patch = sharp(source).extract({ left: x, top: y, width, height })
      patch =
        tool === 'eye_enhance'
          ? patch.modulate({ brightness: 1 + strength * 0.3 }).sharpen(1 + strength)
          : patch
              .median(3)
              .blur(0.3 + strength)
              .modulate({ brightness: 1 + strength * 0.08 })
      return { input: await patch.png().toBuffer(), left: x, top: y }
    }),
  )
  await sharp(source).composite(layers).png().toFile(output(ctx, 'image.png'))
  return result(
    ctx,
    tool === 'eye_enhance' ? '眼部局部增强完成' : '人像局部平滑完成',
    [['image.png', 'image']],
    { regions: regions.length, strength },
  )
}

async function compose(ctx: LocalContext, deps: LocalDependencies) {
  const args = { ...ctx.args, operation: 'stitch', allowImages: true }
  await stitch({ ...ctx, args }, deps)
  if ((Array.isArray(ctx.args.segments) && ctx.args.segments.length) || ctx.args.subtitleUrl) {
    await fs.rename(output(ctx, 'video.mp4'), output(ctx, 'composition-source.mp4'))
    const relative = path
      .relative(await fs.realpath(deps.root), output(ctx, 'composition-source.mp4'))
      .split(path.sep)
      .join('/')
    await captionBurn({ ...ctx, args: { ...ctx.args, sourceUrl: `/static/${relative}` } }, deps)
  }
  if (typeof ctx.args.musicUrl === 'string' && ctx.args.musicUrl) {
    const music = await media(ctx, deps, ctx.args.musicUrl, 'audio'),
      volume = num(ctx.args, 'music_volume', 0.2, 0, 2),
      file = output(ctx, 'video.mp4')
    const info = await probe(ctx, deps, file)
    await fs.rename(file, output(ctx, 'composition-source.mp4'))
    const audio = info.streams?.some((s) => s.codec_type === 'audio')
    const filters = audio
      ? `[1:a]volume=${volume}[bg];[0:a][bg]amix=inputs=2:duration=first:normalize=0[a]`
      : `[1:a]volume=${volume}[a]`
    await ffmpeg(ctx, deps, [
      ...SAFE_INPUT,
      '-i',
      output(ctx, 'composition-source.mp4'),
      '-stream_loop',
      '-1',
      ...SAFE_INPUT,
      '-i',
      music,
      '-filter_complex',
      filters,
      '-map',
      '0:v',
      '-map',
      '[a]',
      '-t',
      String(duration(info)),
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      file,
    ])
  }
  return result(ctx, '视频编排、字幕与配乐合成完成', [['video.mp4', 'video']])
}

async function montage(ctx: LocalContext, deps: LocalDependencies) {
  const musicUrl = str(ctx.args, 'musicUrl', str(ctx.args, 'music_path')),
    music = await media(ctx, deps, musicUrl, 'audio'),
    energy = await audioEnergy(ctx, deps, music),
    urls = sources(ctx.args),
    size = dimensions(ctx.args),
    seconds = Math.min(energy.duration, num(ctx.args, 'duration_seconds', energy.duration, 0.1, 600)),
    target = num(ctx.args, 'shot_duration', 4, 0.5, 15),
    cuts: { sourceUrl: string; start: number; duration: number }[] = []
  const beats = energy.beats.filter((t) => t >= 0.5 && t < seconds)
  let cursor = 0
  while (cursor < seconds - 0.01) {
    const next =
      beats.find((t) => t >= cursor + target && t <= cursor + target + 1) ??
      Math.min(cursor + target, seconds)
    cuts.push({
      sourceUrl: urls[cuts.length % urls.length],
      start: cursor,
      duration: Math.min(next, seconds) - cursor,
    })
    cursor = Math.min(next, seconds)
    if (cuts.length > 150) throw new Error('节拍剪辑片段过多，请增加镜头时长')
  }
  const files: string[] = []
  const preserveAudio = ctx.args.preserve_original_audio === true
  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i],
      source = await media(ctx, deps, cut.sourceUrl, 'video'),
      sourceInfo = await probe(ctx, deps, source),
      sourceDuration = duration(sourceInfo),
      sourceAudio = sourceInfo.streams?.some((stream) => stream.codec_type === 'audio'),
      name = `beat-${i}.mp4`
    await ffmpeg(ctx, deps, [
      '-stream_loop',
      '-1',
      ...SAFE_INPUT,
      '-i',
      source,
      ...(preserveAudio
        ? [
            ...(!sourceAudio ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'] : []),
            '-map',
            '0:v:0',
            '-map',
            sourceAudio ? '0:a:0' : '1:a:0',
            '-c:a',
            'aac',
            '-ar',
            '48000',
            '-ac',
            '2',
          ]
        : ['-an']),
      '-t',
      String(cut.duration),
      '-vf',
      normalizeVideo(size.width, size.height),
      ...ENCODE,
      output(ctx, name),
    ])
    files.push(name)
    ctx.progress((i / cuts.length) * 0.8)
    if (!sourceDuration) throw new Error('素材时长无效')
  }
  await fs.writeFile(output(ctx, 'concat.txt'), files.map((file) => `file '${file}'`).join('\n'))
  await ffmpeg(ctx, deps, [
    '-protocol_whitelist',
    'file',
    '-f',
    'concat',
    '-safe',
    '1',
    '-i',
    output(ctx, 'concat.txt'),
    ...SAFE_INPUT,
    '-i',
    music,
    '-map',
    '0:v',
    ...(preserveAudio
      ? [
          '-filter_complex',
          `[0:a]aresample=48000[a0];[1:a]volume=${num(ctx.args, 'music_volume', 0.2, 0, 2)}[bgm];[a0][bgm]amix=inputs=2:duration=first:normalize=0[a]`,
          '-map',
          '[a]',
        ]
      : ['-map', '1:a']),
    '-t',
    String(seconds),
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    output(ctx, 'video.mp4'),
  ])
  return result(ctx, '音乐节拍混剪完成', [['video.mp4', 'video']], { cuts, duration: seconds })
}

export async function runMediaTool(ctx: LocalContext, deps: LocalDependencies): Promise<ToolResult | null> {
  switch (ctx.toolId) {
    case 'video_stitch':
      return stitch(ctx, deps)
    case 'video_trimmer':
      return trim(ctx, deps)
    case 'audio_mixer':
      return mix(ctx, deps)
    case 'audio_enhance':
      return audioEnhance(ctx, deps)
    case 'subtitle_gen':
      return subtitles(ctx, deps)
    case 'remotion_caption_burn':
      return captionBurn(ctx, deps)
    case 'silence_cutter':
      return silenceCut(ctx, deps)
    case 'auto_reframe':
      return reframe(ctx, deps)
    case 'green_screen_processor':
    case 'green_screen_composite':
      return chroma(ctx, deps)
    case 'upscale':
    case 'color_grade':
    case 'face_enhance':
    case 'eye_enhance':
      return enhancement(ctx, deps)
    case 'video_compose':
    case 'hyperframes_compose':
      return compose(ctx, deps)
    case 'bgm_montage_lite':
      return montage(ctx, deps)
    case 'audio_probe': {
      const file = await media(ctx, deps)
      return jsonResult(ctx, '媒体信息读取完成', { ...(await probe(ctx, deps, file)) })
    }
    case 'audio_energy': {
      const file = await media(ctx, deps)
      return jsonResult(ctx, '音频能量分析完成', await audioEnergy(ctx, deps, file))
    }
    case 'scene_detect': {
      const file = await media(ctx, deps, inputUrl(ctx.args), 'video')
      return jsonResult(ctx, '场景切分检测完成', { scenes: await scenes(ctx, deps, file) })
    }
    case 'frame_sampler': {
      const file = await media(ctx, deps, inputUrl(ctx.args), 'video'),
        extracted = await frames(ctx, deps, file)
      return jsonResult(ctx, '画面抽帧完成', { timestamps: extracted.timestamps }, extracted.names)
    }
    case 'visual_qa': {
      const file = await media(ctx, deps),
        info = await probe(ctx, deps, file),
        expected = ctx.args.expected ? object(ctx.args.expected) : {},
        video = info.streams?.find((s) => s.codec_type === 'video'),
        checks: Record<string, boolean> = {}
      if (expected.width) checks.width = video?.width === expected.width
      if (expected.height) checks.height = video?.height === expected.height
      if (expected.has_audio !== undefined)
        checks.has_audio = !!info.streams?.some((s) => s.codec_type === 'audio') === expected.has_audio
      if (expected.pixel_format) checks.pixel_format = video?.pix_fmt === expected.pixel_format
      if (expected.min_duration !== undefined)
        checks.min_duration = duration(info) >= num(expected, 'min_duration', 0)
      if (expected.max_duration !== undefined)
        checks.max_duration = duration(info) <= num(expected, 'max_duration', 3600)
      if (ctx.args.operation === 'audio_levels')
        return jsonResult(ctx, '音轨电平检查完成', await audioEnergy(ctx, deps, file))
      const extracted =
        ctx.args.operation === 'probe'
          ? { names: [] as Array<[string, 'image']>, timestamps: [] }
          : await frames(ctx, deps, file)
      return jsonResult(
        ctx,
        '媒体质检完成',
        {
          metadata: info,
          checks,
          passed: Object.values(checks).every(Boolean),
          timestamps: extracted.timestamps,
        },
        extracted.names,
      )
    }
    case 'video_analyzer': {
      const file = await media(ctx, deps, inputUrl(ctx.args), 'video'),
        info = await probe(ctx, deps, file),
        sceneList = await scenes(ctx, deps, file),
        extracted = await frames(
          {
            ...ctx,
            args: {
              ...ctx.args,
              strategy: 'count',
              count: num(ctx.args, 'max_keyframes', 8, 1, 50),
              max_frames: 50,
            },
          },
          deps,
          file,
        ),
        energy = info.streams?.some((s) => s.codec_type === 'audio')
          ? await audioEnergy(ctx, deps, file)
          : null
      return jsonResult(
        ctx,
        '参考视频结构分析完成',
        {
          metadata: info,
          scenes: sceneList,
          energy,
          timestamps: extracted.timestamps,
          analysis: { sceneCount: sceneList.length, averageShotSeconds: duration(info) / sceneList.length },
        },
        extracted.names,
      )
    }
    case 'composition_validator': {
      const clips = list(ctx.args, 'clips', 200),
        errors: string[] = []
      if (!clips.length) errors.push('编排至少需要一个片段')
      let total = 0
      for (let i = 0; i < clips.length; i++) {
        const clip = object(clips[i], '编排片段')
        try {
          const url = str(clip, 'sourceUrl', str(clip, 'url'))
          await media(ctx, deps, url)
          const length = num(clip, 'duration', 0, 0.01, 600)
          total += length
        } catch (error) {
          errors.push(`片段 ${i + 1}: ${error instanceof Error ? error.message : '无效'}`)
        }
      }
      if (total > 3600) errors.push('编排总时长超过 60 分钟')
      return jsonResult(ctx, errors.length ? '编排检查发现问题' : '编排检查通过', {
        valid: !errors.length,
        errors,
        duration: total,
        clipCount: clips.length,
      })
    }
    case 'music_library': {
      const urls = list(ctx.args, 'sourceUrls', 100)
      const tracks = []
      for (const url of urls) {
        if (typeof url !== 'string') throw new Error('素材地址须为字符串')
        const file = await media(ctx, deps, url, 'audio')
        tracks.push({ sourceUrl: url, name: path.basename(file), metadata: await probe(ctx, deps, file) })
      }
      return jsonResult(ctx, '音乐素材信息读取完成', { tracks })
    }
    default:
      return null
  }
}
