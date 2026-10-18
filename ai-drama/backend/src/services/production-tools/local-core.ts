import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { validateCreativeMedia } from '../creative-projects.js'
import { STORAGE_ROOT } from '../../utils/paths.js'
import { ffmpegPath, ffprobePath } from '../../utils/ffmpeg.js'

export type FileKind = 'image' | 'video' | 'audio' | 'subtitle' | 'model' | 'archive' | 'data'
export interface ToolFile {
  path: string
  name: string
  kind: FileKind
}
export interface ToolResult {
  summary: string
  files: ToolFile[]
  data?: Record<string, unknown>
}
export interface LocalContext {
  projectId: number
  toolId: string
  args: Record<string, unknown>
  outputDir: string
  signal: AbortSignal
  progress: (value: number) => void
}
export interface LocalDependencies {
  root: string
  validateMedia: typeof validateCreativeMedia
  ffmpeg: string
  ffprobe: string
}
export const localDependencies: LocalDependencies = {
  root: STORAGE_ROOT,
  validateMedia: validateCreativeMedia,
  ffmpeg: ffmpegPath || 'ffmpeg',
  ffprobe: ffprobePath || 'ffprobe',
}
export const SAFE_INPUT = [
  '-protocol_whitelist',
  'file',
  '-format_whitelist',
  'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpegts,mpeg,mpegvideo,mp3,wav,aac,ogg,flac,png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,gif',
]
export const ENCODE = [
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
export const OUTPUT_LIMIT = 512 * 1024 * 1024
export const inside = (root: string, target: string) => {
  const relative = path.relative(root, target)
  return (
    !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  )
}

export function num(args: Record<string, unknown>, key: string, fallback: number, min = 0, max = 3600) {
  const value = args[key] ?? fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`${key} 须在 ${min} 至 ${max} 之间`)
  return value
}
export function str(args: Record<string, unknown>, key: string, fallback = '', max = 20000) {
  const value = args[key] ?? fallback
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))
    throw new Error(`${key} 文本无效或过长`)
  return value
}
export function choice<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: readonly T[],
  fallback: T,
): T {
  const value = args[key] ?? fallback
  if (!values.includes(value as T)) throw new Error(`${key} 仅支持 ${values.join('、')}`)
  return value as T
}
export function list(args: Record<string, unknown>, key: string, maximum = 100): unknown[] {
  const value = args[key] ?? []
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error(`${key} 须为不超过 ${maximum} 项的列表`)
  return value
}
export function object(value: unknown, label = '参数'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 须为对象`)
  return value as Record<string, unknown>
}
export function inputUrl(args: Record<string, unknown>) {
  return str(args, 'sourceUrl', str(args, 'input_path', str(args, 'video_path', str(args, 'source'))))
}
export function inferKind(url: string): 'image' | 'video' | 'audio' {
  const extension = path.extname(url).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.svg'].includes(extension)) return 'image'
  if (['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'].includes(extension)) return 'audio'
  return 'video'
}
/** Non-media artifacts need the same project confinement, without lying about their media type. */
export async function asset(
  ctx: LocalContext,
  deps: LocalDependencies,
  url: string,
  extensions: readonly string[],
): Promise<string> {
  if (
    !url.startsWith('/static/') ||
    /[\\%?#:\x00-\x1f]/.test(url) ||
    url.split('/').some((part, index) => index > 0 && (!part || part === '.' || part === '..'))
  )
    throw new Error('请选择已上传的本地文件')
  if (!extensions.includes(path.extname(url).toLowerCase())) throw new Error('不支持此类素材文件')
  if (!url.startsWith(`/static/creative/${ctx.projectId}/`) && !url.startsWith('/static/uploads/'))
    throw new Error('只能读取当前项目或已上传的文件')
  const root = await fs.realpath(deps.root),
    file = await fs.realpath(path.resolve(root, url.slice('/static/'.length)))
  if (!inside(root, file) || !(await fs.stat(file)).isFile()) throw new Error('文件路径超出素材目录')
  const scope = url.startsWith('/static/uploads/')
    ? path.join(root, 'uploads')
    : path.join(root, 'creative', String(ctx.projectId))
  if (!inside(scope, file)) throw new Error('文件不能通过符号链接访问其他项目的素材')
  return file
}
export async function media(
  ctx: LocalContext,
  deps: LocalDependencies,
  url = inputUrl(ctx.args),
  expected?: 'image' | 'video' | 'audio',
): Promise<string> {
  if (
    !url ||
    !url.startsWith('/static/') ||
    /[\\%?#:\x00-\x1f]/.test(url) ||
    url.split('/').some((part, index) => index > 0 && (!part || part === '.' || part === '..'))
  )
    throw new Error('请选择已上传的本地素材，不支持外部地址或文件系统路径')
  const kind = expected ?? inferKind(url)
  if (url.toLowerCase().endsWith('.svg') && kind === 'image') {
    const source = await asset(ctx, deps, url, ['.svg']),
      stat = await fs.stat(source)
    if (stat.size > 2 * 1024 * 1024) throw new Error('SVG 文件超过 2 MB')
    const vector = await fs.readFile(source, 'utf8')
    // SVG has no executable or external-resource role in the media pipeline.
    if (
      /<!DOCTYPE|<!ENTITY|<\s*(?:script|foreignObject|iframe|object|embed|image|use)\b|\bon\w+\s*=|(?:href|src)\s*=|url\s*\(|@import/i.test(
        vector,
      )
    )
      throw new Error('SVG 不能包含脚本、嵌入对象或外部资源')
    const destination = output(
      ctx,
      `input-${createHash('sha256').update(url).digest('hex').slice(0, 12)}.png`,
    )
    await sharp(Buffer.from(vector), { limitInputPixels: 33554432 })
      .resize({ width: 3840, height: 3840, fit: 'inside', withoutEnlargement: true })
      .png()
      .toFile(destination)
    return destination
  }
  deps.validateMedia(ctx.projectId, url, kind)
  const root = await fs.realpath(deps.root)
  const file = await fs.realpath(path.resolve(root, url.slice('/static/'.length)))
  if (!inside(root, file) || !(await fs.stat(file)).isFile())
    throw new Error('素材超出存储目录或不是普通文件')
  if (
    url.startsWith(`/static/creative/${ctx.projectId}/`) &&
    !inside(path.join(root, 'creative', String(ctx.projectId)), file)
  )
    throw new Error('素材不能通过符号链接访问其他项目')
  if (url.startsWith('/static/uploads/') && !inside(path.join(root, 'uploads'), file))
    throw new Error('上传素材不能通过符号链接访问项目目录')
  return file
}
export async function prepare(ctx: LocalContext, deps: LocalDependencies) {
  ctx.signal.throwIfAborted()
  await fs.mkdir(ctx.outputDir, { recursive: true })
  const root = await fs.realpath(deps.root),
    output = await fs.realpath(ctx.outputDir)
  if (!inside(root, output)) throw new Error('工具输出目录必须位于本地素材目录内')
  // A new job directory must not contain symlinks or old outputs controlled by an upload.
  for (const name of await fs.readdir(output))
    if ((await fs.lstat(path.join(output, name))).isSymbolicLink())
      throw new Error('工具输出目录不能包含符号链接')
  return output
}
export function output(ctx: LocalContext, filename: string) {
  if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$/.test(filename)) throw new Error('工具输出文件名无效')
  return path.join(ctx.outputDir, filename)
}
export async function run(
  ctx: LocalContext,
  binary: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number; cwd?: string } = {},
): Promise<Buffer> {
  ctx.signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        encoding: 'buffer',
        timeout: options.timeout ?? 120000,
        maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
        signal: ctx.signal,
        killSignal: 'SIGKILL',
        windowsHide: true,
        cwd: options.cwd ?? ctx.outputDir,
      },
      (error, stdout, stderr) => {
        if (error) {
          if (ctx.signal.aborted) {
            reject(new Error('任务已取消'))
            return
          }
          const detail = stderr?.toString().trim().slice(-1200) || error.message
          reject(new Error(`本地处理失败（${path.basename(binary)}）：${detail}`))
          return
        }
        resolve(stdout)
      },
    )
  })
}
export async function ffmpeg(ctx: LocalContext, deps: LocalDependencies, args: string[], timeout = 600000) {
  return run(ctx, deps.ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], {
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  })
}
export interface Probe {
  format?: { duration?: string; format_name?: string; size?: string }
  streams?: {
    codec_type?: string
    codec_name?: string
    width?: number
    height?: number
    duration?: string
    sample_rate?: string
    channels?: number
    pix_fmt?: string
    avg_frame_rate?: string
  }[]
}
export async function probe(ctx: LocalContext, deps: LocalDependencies, file: string): Promise<Probe> {
  const result = await run(
    ctx,
    deps.ffprobe,
    ['-v', 'error', ...SAFE_INPUT, '-show_format', '-show_streams', '-of', 'json', file],
    { timeout: 30000 },
  )
  return JSON.parse(result.toString()) as Probe
}
export function duration(value: Probe) {
  const result = Number(value.format?.duration ?? value.streams?.find((s) => s.duration)?.duration)
  if (!Number.isFinite(result) || result <= 0 || result > 3600)
    throw new Error('素材时长无效或超过 60 分钟，请先拆分素材')
  return result
}
export function dimensions(args: Record<string, unknown>, defaultWidth = 1280, defaultHeight = 720) {
  const width = Math.round(num(args, 'width', defaultWidth, 64, 3840) / 2) * 2,
    height = Math.round(num(args, 'height', defaultHeight, 64, 3840) / 2) * 2
  if (width * height > 8294400) throw new Error('画面总像素超过 4K 限制')
  return { width, height }
}
export function normalizeVideo(width: number, height: number, fit: 'pad' | 'crop' = 'pad') {
  return fit === 'crop'
    ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=30,format=yuv420p`
    : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p`
}
export async function result(
  ctx: LocalContext,
  summary: string,
  names: Array<[string, FileKind]>,
  data?: Record<string, unknown>,
): Promise<ToolResult> {
  const realDir = await fs.realpath(ctx.outputDir)
  const files = await Promise.all(
    names.map(async ([name, kind]) => {
      const file = await fs.realpath(output(ctx, name)),
        stat = await fs.stat(file)
      if (!inside(realDir, file) || !stat.isFile() || stat.size <= 0 || stat.size > OUTPUT_LIMIT)
        throw new Error('工具未生成有效文件，或文件超过 512 MB')
      return { path: file, name, kind }
    }),
  )
  ctx.signal.throwIfAborted()
  ctx.progress(1)
  return { summary, files, ...(data ? { data } : {}) }
}
export async function jsonResult(
  ctx: LocalContext,
  summary: string,
  data: Record<string, unknown>,
  extra: Array<[string, FileKind]> = [],
): Promise<ToolResult> {
  await fs.writeFile(output(ctx, 'report.json'), JSON.stringify(data, null, 2))
  return result(ctx, summary, [['report.json', 'data'], ...extra], data)
}
export const xml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
  )
