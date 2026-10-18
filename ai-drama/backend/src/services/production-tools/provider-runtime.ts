/** Shared, bounded transport and media boundary for provider-backed production tools. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ffprobePath } from '../../utils/ffmpeg.js'
import { inspectGlb } from '../creative-tools/files.js'
const exec = promisify(execFile)
import { remoteBytes } from '../creative-tools/network.js'
import { STORAGE_ROOT } from '../../utils/paths.js'
export type OutputKind = 'image' | 'video' | 'audio' | 'subtitle' | 'model' | 'archive' | 'data'
export interface ProviderConfig {
  id?: number
  provider: string
  baseUrl: string
  apiKey: string
  model: string
}
export interface ProviderContext {
  projectId: number
  toolId: string
  args: Record<string, unknown>
  outputDir: string
  signal: AbortSignal
  progress: (value: number) => void
  config?: ProviderConfig
  checkpoint: (value: Record<string, unknown>) => void
  state: Record<string, unknown>
}
export interface ProviderResult {
  summary: string
  files: { path: string; name: string; kind: OutputKind }[]
  data?: Record<string, unknown>
}
export interface ProviderDependencies {
  fetch: typeof globalThis.fetch
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  download: (url: string, domains: readonly string[], limit: number) => Promise<Buffer>
  readMedia: (
    ctx: ProviderContext,
    value: string,
    kind: 'image' | 'video' | 'audio',
  ) => Promise<{ bytes: Buffer; name: string; mime: string }>
}
export const providerDependencies: ProviderDependencies = {
  fetch: (...a) => globalThis.fetch(...a),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      signal.throwIfAborted()
      const done = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
      }
      const abort = () => {
        done()
        reject(signal.reason)
      }
      const timer = setTimeout(() => {
        done()
        resolve()
      }, ms)
      signal.addEventListener('abort', abort, { once: true })
    }),
  download: remoteBytes,
  readMedia: async (ctx, value, kind) => {
    const { validateCreativeMedia } = await import('../creative-projects.js')
    validateCreativeMedia(ctx.projectId, value, kind)
    const file = path.join(STORAGE_ROOT, value.replace(/^\/?static\//, '')),
      stat = await fs.stat(file)
    if (stat.size > 50 * 1024 * 1024) throw new Error('服务输入文件超过 50 MB，请先裁剪或压缩')
    const ext = path.extname(file).toLowerCase(),
      mime = (
        {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webp': 'image/webp',
          '.avif': 'image/avif',
          '.mp4': 'video/mp4',
          '.mov': 'video/quicktime',
          '.webm': 'video/webm',
          '.wav': 'audio/wav',
          '.mp3': 'audio/mpeg',
          '.m4a': 'audio/mp4',
          '.ogg': 'audio/ogg',
          '.flac': 'audio/flac',
        } as Record<string, string>
      )[ext]
    if (!mime) throw new Error('服务不支持这个输入文件格式')
    return { bytes: await fs.readFile(file), name: path.basename(file), mime }
  },
}
export function str(args: Record<string, unknown>, keys: string | string[], fallback = '') {
  for (const k of Array.isArray(keys) ? keys : [keys]) {
    const v = args[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return fallback
}
export function num(
  args: Record<string, unknown>,
  keys: string | string[],
  fallback: number,
  min: number,
  max: number,
) {
  for (const k of Array.isArray(keys) ? keys : [keys]) {
    const raw = args[k]
    if (raw === undefined || raw === null || raw === '') continue
    const n = Number(raw)
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${k} 须在 ${min} 到 ${max} 之间`)
    return n
  }
  return fallback
}
export function required(args: Record<string, unknown>, keys: string | string[], label: string) {
  const v = str(args, keys)
  if (!v) throw new Error(`请提供${label}`)
  return v
}
export function checkpoint(ctx: ProviderContext, value: Record<string, unknown>) {
  Object.assign(ctx.state, value)
  ctx.checkpoint({ ...ctx.state })
}
export function ensureCanSubmit(ctx: ProviderContext) {
  if (ctx.state.submissionStarted && !ctx.state.remoteId && !ctx.state.rejected)
    throw new Error(
      '上次提交是否被服务接收尚不确定；请填写服务端任务 ID 恢复查询，或核对服务控制台后新建任务，避免重复计费',
    )
  if (ctx.state.rejected) checkpoint(ctx, { submissionStarted: false, rejected: false })
}
export function serviceUrl(config: ProviderConfig, suffix: string, version = '') {
  const u = new URL(config.baseUrl)
  if (u.username || u.password || u.search || u.hash || !['http:', 'https:'].includes(u.protocol))
    throw new Error('模型服务地址无效')
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  if (u.protocol !== 'https:' && !(isLocal && config.provider === 'comfyui'))
    throw new Error('云端模型服务须使用 HTTPS')
  const base = u.href.replace(/\/$/, '')
  return base + (version && !base.endsWith(version) ? version : '') + suffix
}
export async function responseBytes(response: Response, max = 8 * 1024 * 1024) {
  if (Number(response.headers.get('content-length') || 0) > max) throw new Error('服务返回内容超过大小限制')
  const parts: Buffer[] = []
  let size = 0
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > max) {
        await reader.cancel()
        throw new Error('服务返回内容超过大小限制')
      }
      parts.push(Buffer.from(item.value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(parts)
}
export async function request(
  ctx: ProviderContext,
  deps: ProviderDependencies,
  url: string,
  init: RequestInit = {},
  binary = false,
) {
  ctx.signal.throwIfAborted()
  let res: Response
  try {
    res = await deps.fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(binary ? 300000 : 120000)]),
    })
  } catch (error) {
    if (ctx.signal.aborted) throw ctx.signal.reason
    throw new Error(`服务连接中断，请恢复任务继续查询；提交状态以服务控制台为准`)
  }
  if (!res.ok) {
    await res.body?.cancel()
    if (
      res.status >= 400 &&
      res.status < 500 &&
      ![408, 409].includes(res.status) &&
      init.method === 'POST' &&
      ctx.state.submissionStarted &&
      !ctx.state.remoteId
    )
      checkpoint(ctx, { rejected: true })
    throw new Error(`模型服务返回 HTTP ${res.status}，请检查密钥、额度、模型权限和参数`)
  }
  if (binary && /application\/json|text\/html/.test(res.headers.get('content-type') || '')) {
    await res.body?.cancel()
    throw new Error('服务未返回媒体文件，请检查账户权限与参数')
  }
  return res
}
export async function jsonRequest(
  ctx: ProviderContext,
  deps: ProviderDependencies,
  url: string,
  init: RequestInit = {},
  maxBytes = 64 * 1024 * 1024,
) {
  const res = await request(ctx, deps, url, init)
  let data: any
  try {
    data = JSON.parse((await responseBytes(res, maxBytes)).toString('utf8'))
  } catch {
    throw new Error('模型服务返回了无效的 JSON 内容')
  }
  if (!data || typeof data !== 'object') throw new Error('模型服务返回结构无效')
  return data
}
export const jsonBody = (value: unknown) => JSON.stringify(value)
export const bearer = (key: string) => ({
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
})
export async function mediaDataUri(
  ctx: ProviderContext,
  deps: ProviderDependencies,
  value: string,
  kind: 'image' | 'video' | 'audio',
) {
  const file = await deps.readMedia(ctx, value, kind)
  return `data:${file.mime};base64,${file.bytes.toString('base64')}`
}
export async function outputBytes(
  ctx: ProviderContext,
  bytes: Buffer,
  kind: OutputKind,
  extension: string,
  name?: string,
) {
  if (!bytes.length) throw new Error('模型服务没有返回可用文件')
  if (!/^[a-z0-9]{1,8}$/.test(extension)) throw new Error('输出扩展名无效')
  if (kind === 'image') {
    if (/^\s*(?:<|\{|\[)/.test(bytes.subarray(0, 80).toString('utf8')))
      throw new Error('图片服务返回了文本或不支持的矢量内容，请使用 PNG/JPEG/WebP 输出')
    try {
      const decoder = sharp(bytes, { limitInputPixels: 64000000 }),
        metadata = await decoder.metadata()
      await decoder.resize({ width: 1, height: 1, fit: 'inside' }).toBuffer()
      if (
        !metadata.width ||
        !metadata.height ||
        !['png', 'jpeg', 'webp', 'gif', 'avif', 'heif', 'tiff'].includes(metadata.format || '')
      )
        throw new Error()
      // Normalize formats that the project media boundary cannot import directly.
      if (metadata.format === 'tiff' || metadata.format === 'heif') {
        bytes = await sharp(bytes, { limitInputPixels: 64000000 }).png().toBuffer()
        extension = 'png'
      } else extension = metadata.format === 'jpeg' ? 'jpg' : metadata.format!
    } catch {
      throw new Error('图片服务返回的文件不是有效图片')
    }
  }
  if (kind === 'model' && extension === 'glb') inspectGlb(bytes)
  await fs.mkdir(ctx.outputDir, { recursive: true })
  const real = await fs.realpath(ctx.outputDir),
    filename = `${ctx.toolId.replace(/[^a-z0-9_-]/gi, '-')}-${randomUUID()}.${extension}`,
    file = path.join(real, filename)
  await fs.writeFile(file, bytes, { flag: 'wx' })
  if (kind === 'video' || kind === 'audio') {
    try {
      const result = await exec(
        ffprobePath || 'ffprobe',
        [
          '-v',
          'error',
          '-protocol_whitelist',
          'file,pipe',
          '-show_entries',
          'stream=codec_type:format=duration',
          '-of',
          'json',
          file,
        ],
        { timeout: 30000, maxBuffer: 1024 * 1024, signal: ctx.signal },
      )
      const probe = JSON.parse(result.stdout)
      if (
        !Array.isArray(probe.streams) ||
        !probe.streams.some((stream: any) => stream.codec_type === (kind === 'video' ? 'video' : 'audio')) ||
        !(Number(probe.format?.duration) > 0)
      )
        throw new Error()
    } catch {
      await fs.rm(file, { force: true })
      throw new Error('模型服务返回的媒体文件不可解码，或缺少有效时长，请核对服务端产物')
    }
  }
  return { path: file, name: name || filename, kind }
}
export async function outputRemote(
  ctx: ProviderContext,
  deps: ProviderDependencies,
  url: string,
  kind: OutputKind,
  domains: readonly string[],
  extension?: string,
) {
  const ext =
    extension ||
    path.extname(new URL(url).pathname).slice(1).toLowerCase() ||
    {
      image: 'png',
      audio: 'mp3',
      video: 'mp4',
      model: 'glb',
      archive: 'zip',
      subtitle: 'srt',
      data: 'json',
    }[kind]
  const bytes = await deps.download(
    url,
    domains,
    kind === 'model' || kind === 'video' ? 512 * 1024 * 1024 : 100 * 1024 * 1024,
  )
  ctx.signal.throwIfAborted()
  return outputBytes(ctx, bytes, kind, ext)
}
export async function outputJson(ctx: ProviderContext, data: unknown, name = 'results.json') {
  return outputBytes(ctx, Buffer.from(JSON.stringify(data, null, 2)), 'data', 'json', name)
}
export async function poll(
  ctx: ProviderContext,
  deps: ProviderDependencies,
  read: () => Promise<any>,
  done: (data: any) => boolean,
  failed: (data: any) => boolean,
) {
  const started = Number(ctx.state.pollStarted) || Date.now()
  if (!ctx.state.pollStarted) checkpoint(ctx, { pollStarted: started })
  for (let attempt = 0; Date.now() - started < 6 * 60 * 60 * 1000; attempt++) {
    const data = await read()
    if (failed(data)) {
      checkpoint(ctx, { providerFailed: true })
      throw new Error('服务端任务失败，请检查服务控制台的失败原因后新建任务')
    }
    if (done(data)) return data
    ctx.progress(Math.min(85, 15 + attempt))
    await deps.sleep(Math.min(10000, 1500 + attempt * 500), ctx.signal)
  }
  throw new Error('等待服务端任务超过 6 小时，请核对服务控制台后恢复查询')
}
export async function submitJson(
  ctx: ProviderContext,
  deps: ProviderDependencies,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  extractId: (v: any) => unknown,
) {
  ensureCanSubmit(ctx)
  checkpoint(ctx, {
    submissionStarted: true,
    provider: ctx.config?.provider,
    configId: ctx.config?.id,
    model: ctx.config?.model,
  })
  const data = await jsonRequest(ctx, deps, url, {
    method: 'POST',
    headers,
    body: jsonBody(body),
  })
  const id = extractId(data)
  if (typeof id !== 'string' || !id)
    throw new Error('服务未返回任务 ID，提交结果待核实；请在服务控制台确认后填写任务 ID')
  checkpoint(ctx, { remoteId: id })
  ctx.progress(15)
  return data
}
export function xml(value: string) {
  return value.replace(
    /[<>&"']/g,
    (s) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
        "'": '&apos;',
      })[s]!,
  )
}
