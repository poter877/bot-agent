/**
 * HTTP 客户端 — /api/v1 同源 fetch 的唯一入口。
 *
 * 与旧 useApi 的语义差异（迁移修正项）：
 * - envelope 显式为 { code, data, message }；data 为 null 时返回 null，
 *   不再沿用 `data ?? envelope` 导致调用方拿到错误形状
 * - 支持 AbortSignal 与按请求类型超时（常规 GET 30s / Agent 10min / 上传 2min），
 *   超时以 TimeoutError 抛出，与业务错误区分
 * - 日志只记录方法、去敏路径、耗时与状态码；不打印请求/响应正文（旧版会打印完整 body）
 */

export class ApiError extends Error {
  /** 后端业务码（envelope.code），如 400/404/500 */
  readonly code: number
  /** HTTP 状态码 */
  readonly status: number

  constructor(message: string, code: number, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

/** 请求超时（等待响应超过限制），区别于后端任务失败 */
export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`request timeout after ${ms}ms`)
    this.name = 'TimeoutError'
  }
}

export const TIMEOUT = {
  /** 常规请求 */
  default: 30_000,
  /** Agent chat：请求式长流程（剧本改写/提取/拆镜/提示词） */
  agent: 600_000,
  /** 文件上传（视频最大 50MB） */
  upload: 120_000,
} as const

export interface RequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

const BASE = '/api/v1'

function log(method: string, path: string, status: string, ms: number, isError = false) {
  const style = isError ? 'color:#ef5350' : 'color:#66bb6a'
  console.debug(`%c[API]%c ${method} ${path} %c${status} %c${ms}ms`, 'color:#888', 'color:#4fc3f7;font-weight:bold', `${style};font-weight:bold`, 'color:#888')
}

function linkSignals(external: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new TimeoutError(timeoutMs)), timeoutMs)
  const onExternalAbort = () => controller.abort(external?.reason)
  if (external) {
    if (external.aborted) controller.abort(external.reason)
    else external.addEventListener('abort', onExternalAbort, { once: true })
  }
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer)
      external?.removeEventListener('abort', onExternalAbort)
    },
  }
}

function abortReason(err: unknown): unknown {
  if (err instanceof Error && err.name === 'TimeoutError') return new TimeoutError(0)
  return err
}

async function parseEnvelope(resp: Response): Promise<{ code: number; data: unknown; message?: string }> {
  const json = (await resp.json().catch(() => null)) as { code?: number; data?: unknown; message?: string } | null
  if (!json || typeof json !== 'object') {
    throw new ApiError(String(resp.status), resp.status, resp.status)
  }
  return { code: json.code ?? resp.status, data: json.data === undefined ? null : json.data, message: json.message }
}

async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT.default
  const { signal, cancel } = linkSignals(opts.signal, timeoutMs)
  const start = performance.now()

  const init: RequestInit = {
    method,
    signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }

  try {
    const resp = await fetch(`${BASE}${path}`, init)
    const ms = Math.round(performance.now() - start)
    const envelope = await parseEnvelope(resp)

    if (!resp.ok || envelope.code >= 400) {
      log(method, path, String(resp.status), ms, true)
      throw new ApiError(envelope.message || String(resp.status), envelope.code, resp.status)
    }

    log(method, path, String(resp.status), ms)
    return envelope.data as T
  } catch (err) {
    const reason = abortReason(err)
    if (reason instanceof TimeoutError) {
      log(method, path, 'TIMEOUT', Math.round(performance.now() - start), true)
      throw reason
    }
    if (err instanceof ApiError) throw err
    // fetch 网络层失败（断网/中止/非 JSON 响应）
    log(method, path, 'ERROR', Math.round(performance.now() - start), true)
    throw err
  } finally {
    cancel()
  }
}

async function requestForm<T>(path: string, file: File, opts: RequestOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT.upload
  const { signal, cancel } = linkSignals(opts.signal, timeoutMs)
  const start = performance.now()
  const fd = new FormData()
  fd.append('file', file)
  try {
    const resp = await fetch(`${BASE}${path}`, { method: 'POST', body: fd, signal })
    const ms = Math.round(performance.now() - start)
    const envelope = await parseEnvelope(resp)
    if (!resp.ok || envelope.code >= 400) {
      log('POST', path, String(resp.status), ms, true)
      throw new ApiError(envelope.message || String(resp.status), envelope.code, resp.status)
    }
    log('POST', path, String(resp.status), ms)
    return envelope.data as T
  } finally {
    cancel()
  }
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, body, opts),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, body, opts),
  del: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, undefined, opts),
  upload: <T>(path: string, file: File, opts?: RequestOptions) => requestForm<T>(path, file, opts),
}

/** query string 组装（跳过空值） */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const s = search.toString()
  return s ? `?${s}` : ''
}
