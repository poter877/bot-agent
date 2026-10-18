import type { MediaCatalogEntry } from './catalog.js'

/**
 * The async-poll media providers (ai-drama's vendor set moved behind the
 * catalog): submit → poll → download → base64, all server-side, so the wire
 * keeps the synchronous media envelope and vendor task queues never leak to
 * clients. Per-vendor request shapes are ported from ai-drama's adapters;
 * the keys are ours, model ids come from the catalog entry — never the client.
 */

export interface VendorVideoRequest {
  prompt: string
  generateAudio?: boolean
  aspectRatio?: string
  resolution?: string
  duration?: number
  seed?: number
  imageUrl?: string
  firstFrameUrl?: string
  lastFrameUrl?: string
  referenceImages?: string[]
  referenceVideos?: string[]
  referenceAudios?: string[]
  referenceFileUrl?: string
  referenceLinkUrl?: string
  promptExtend?: boolean
  watermark?: boolean
}

export interface VendorMediaResult {
  media_type: string
  base64: string
}

export interface PollingProviderDeps {
  fetchImpl?: typeof fetch
  /** Poll cadence; the overall budget is the caller's request deadline. */
  intervalMs?: number
}

const POLL_INTERVAL_MS = 5_000
const DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024

const VOLCENGINE_BASE = 'https://ark.cn-beijing.volces.com'
const MINIMAX_BASE = 'https://api.minimax.chat'
const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com'

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

function normalizeDuration(value: number | undefined, fallback: number, min: number, max: number): number {
  const parsed = Math.round(Number(value ?? fallback))
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

const errorText = (err: unknown): string => {
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const code = 'code' in err && err.code ? `[${err.code}] ` : ''
    return `${code}${('message' in err && typeof err.message === 'string' && err.message) || JSON.stringify(err)}`
  }
  return String(err ?? 'Generation failed')
}

async function postJson(
  fetchImpl: typeof fetch, url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (!response.ok || parsed === undefined) {
    const detail = text.slice(0, 300)
    throw new Error(`HTTP ${response.status}: ${detail}`)
  }
  return parsed as Record<string, unknown>
}

async function getJson(
  fetchImpl: typeof fetch, url: string, headers: Record<string, string>, signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, { method: 'GET', headers, signal })
  const text = await response.text()
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`)
  }
}

/** Download the finished asset. Bytes stream through a hard cap so a vendor
 * cannot pin server memory with a giant content-length lie or trickle. */
async function downloadAsBase64(fetchImpl: typeof fetch, url: string, signal: AbortSignal): Promise<VendorMediaResult> {
  const response = await fetchImpl(url, { signal })
  if (!response.ok) throw new Error(`asset download failed: HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > DOWNLOAD_MAX_BYTES) throw new Error('asset exceeds the download size cap')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > DOWNLOAD_MAX_BYTES) throw new Error('asset exceeds the download size cap')
  return {
    media_type: response.headers.get('content-type')?.split(';')[0]?.trim() || 'video/mp4',
    base64: buffer.toString('base64'),
  }
}

interface PollOutcome {
  url?: string
  failed?: string
}

async function pollUntilDone(
  poll: () => Promise<PollOutcome>,
  deps: Required<Pick<PollingProviderDeps, 'intervalMs'>>,
  startedAt: number,
  deadlineMs: number,
  signal: AbortSignal,
): Promise<string> {
  for (;;) {
    if (signal.aborted) throw new Error('aborted')
    if (Date.now() >= deadlineMs) throw new Error('Media generation timed out.')
    await new Promise((resolve) => setTimeout(resolve, deps.intervalMs))
    const outcome = await poll()
    if (outcome.failed !== undefined) throw new Error(outcome.failed)
    if (outcome.url !== undefined) return outcome.url
    if (Date.now() + deps.intervalMs >= deadlineMs) throw new Error('Media generation timed out.')
  }
}

const firstUrl = (...values: ReadonlyArray<unknown>): string | undefined => {
  const hit = values.find((value) => typeof value === 'string' && value.trim() !== '')
  return typeof hit === 'string' ? hit : undefined
}

// ── Volcengine Ark (Seedance 2.0 video, Seedream image) ────────────────────

const volcengineVideoBody = (entry: MediaCatalogEntry, request: VendorVideoRequest): unknown => {
  const content: Array<Record<string, unknown>> = []
  if (request.prompt) content.push({ type: 'text', text: request.prompt })
  for (const url of request.referenceImages ?? []) content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
  for (const url of request.referenceVideos ?? []) content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
  for (const url of request.referenceAudios ?? []) content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })
  return {
    model: entry.model,
    content,
    generate_audio: request.generateAudio !== false,
    ratio: request.aspectRatio || 'adaptive',
    duration: normalizeDuration(request.duration, 5, 4, 15),
    // Seedance 2.0 serves 480p/720p only; anything higher converges to 720p.
    resolution: request.resolution === '480p' ? '480p' : '720p',
    watermark: false,
  }
}

// ── MiniMax H3 video ────────────────────────────────────────────────────────

const VALID_MINIMAX_RATIOS = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'])

const minimaxVideoBody = (entry: MediaCatalogEntry, request: VendorVideoRequest): unknown => {
  const firstFrame = asString(request.firstFrameUrl ?? request.imageUrl)
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: request.prompt }]
  if (firstFrame) content.push({ type: 'image_url', image_url: { url: firstFrame }, role: 'first_frame' })
  if (asString(request.lastFrameUrl)) content.push({ type: 'image_url', image_url: { url: asString(request.lastFrameUrl) }, role: 'last_frame' })
  for (const url of request.referenceImages ?? []) content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
  for (const url of request.referenceVideos ?? []) content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
  for (const url of request.referenceAudios ?? []) content.push({ type: 'audio_url', audio_url: { url } })
  const resolution = request.resolution?.toLowerCase() === '2k' || request.resolution?.toLowerCase() === '1080p' ? '2K' : '768P'
  const body: Record<string, unknown> = {
    model: entry.model,
    content,
    duration: normalizeDuration(request.duration, 5, 4, 15),
    resolution,
  }
  // Image-to-video omits the ratio (it is adaptive by definition); text-to-video requires one.
  if (!firstFrame) body.ratio = VALID_MINIMAX_RATIOS.has(request.aspectRatio ?? '') ? request.aspectRatio : '16:9'
  return body
}

// ── Aliyun DashScope Wan 3.0 video ──────────────────────────────────────────

const wanPromptOf = (request: VendorVideoRequest): string =>
  // ai-drama's internal @图片N markers map onto the official 图N reference syntax.
  request.prompt.replace(/@图片(\d+)/g, '图$1')

const wanVideoBody = (entry: MediaCatalogEntry, request: VendorVideoRequest): unknown => {
  const media: Array<{ type: string; url: string }> = []
  const firstFrame = asString(request.firstFrameUrl ?? request.imageUrl)
  const lastFrame = asString(request.lastFrameUrl)
  if (firstFrame) media.push({ type: 'first_frame', url: firstFrame })
  if (lastFrame) media.push({ type: 'last_frame', url: lastFrame })
  for (const url of request.referenceImages ?? []) media.push({ type: 'reference_image', url })
  for (const url of request.referenceVideos ?? []) media.push({ type: 'reference_video', url })
  for (const url of request.referenceAudios ?? []) media.push({ type: 'reference_audio', url })
  if (asString(request.referenceFileUrl)) media.push({ type: 'file', url: asString(request.referenceFileUrl) })
  if (asString(request.referenceLinkUrl)) media.push({ type: 'link', url: asString(request.referenceLinkUrl) })

  const input: Record<string, unknown> = {}
  if (request.prompt) input.prompt = wanPromptOf(request)
  if (media.length > 0) input.media = media

  return {
    model: entry.model,
    input,
    parameters: {
      resolution: request.resolution ? request.resolution.toUpperCase() : '720P',
      ratio: request.aspectRatio || 'adaptive',
      duration: normalizeDuration(request.duration, 5, 4, 15),
      audio: request.generateAudio !== false,
      prompt_extend: request.promptExtend !== false,
      watermark: request.watermark === true,
    },
  }
}

// ── Dispatch ────────────────────────────────────────────────────────────────

export async function generatePollingVideo(
  provider: 'volcengine' | 'minimax' | 'aliyun',
  key: string,
  entry: MediaCatalogEntry,
  request: VendorVideoRequest,
  timeoutMs: number,
  signal: AbortSignal,
  deps: PollingProviderDeps = {},
): Promise<VendorMediaResult[]> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const intervalMs = deps.intervalMs ?? POLL_INTERVAL_MS
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs

  let outcome: string
  if (provider === 'volcengine') {
    const headers = { Authorization: `Bearer ${key}` }
    const submitted = await postJson(
      fetchImpl, `${VOLCENGINE_BASE}/api/v3/contents/generations/tasks`, headers, volcengineVideoBody(entry, request), signal,
    )
    const taskId = firstUrl(submitted['id'], submitted['task_id'])
    if (taskId === undefined) throw new Error('Vendor did not return a task id')
    outcome = await pollUntilDone(async (): Promise<PollOutcome> => {
      const poll = await getJson(fetchImpl, `${VOLCENGINE_BASE}/api/v3/contents/generations/tasks/${taskId}`, headers, signal)
      const status = poll['status']
      if (status === 'succeeded') return { url: firstUrl(poll['video_url'], (poll['content'] as any)?.video_url, (poll['data'] as any)?.video_url) }
      if (status === 'failed') return { failed: errorText(poll['error'] ?? 'Video generation failed') }
      return {}
    }, { intervalMs }, startedAt, deadline, signal)
  } else if (provider === 'minimax') {
    const headers = { Authorization: `Bearer ${key}` }
    const submitted = await postJson(fetchImpl, `${MINIMAX_BASE}/v2/video_generation`, headers, minimaxVideoBody(entry, request), signal)
    const taskId = firstUrl(submitted['task_id'])
    if (taskId === undefined) throw new Error('Vendor did not return a task id')
    outcome = await pollUntilDone(async (): Promise<PollOutcome> => {
      const poll = await getJson(fetchImpl, `${MINIMAX_BASE}/v2/query/video_generation/${taskId}`, headers, signal)
      const task = poll['task'] && typeof poll['task'] === 'object' ? (poll['task'] as Record<string, unknown>) : poll
      if (task['status'] === 'succeeded') return { url: firstUrl((task['content'] as any)?.url, task['video_url']) }
      if (task['status'] === 'failed' || task['status'] === 'cancelled') {
        return { failed: errorText(task['error'] ?? 'Video generation failed') }
      }
      return {}
    }, { intervalMs }, startedAt, deadline, signal)
  } else {
    const headers = { Authorization: `Bearer ${key}`, 'X-DashScope-Async': 'enable' }
    const submitted = await postJson(
      fetchImpl, `${DASHSCOPE_BASE}/api/v1/services/aigc/video-generation/video-synthesis`, headers, wanVideoBody(entry, request), signal,
    )
    const taskId = firstUrl((submitted['output'] as any)?.task_id)
    if (taskId === undefined) throw new Error('Vendor did not return a task id')
    outcome = await pollUntilDone(async (): Promise<PollOutcome> => {
      const poll = await getJson(fetchImpl, `${DASHSCOPE_BASE}/api/v1/tasks/${encodeURIComponent(taskId)}`, { Authorization: `Bearer ${key}` }, signal)
      const output = poll['output'] && typeof poll['output'] === 'object' ? (poll['output'] as Record<string, unknown>) : {}
      switch (output['task_status']) {
        case 'SUCCEEDED': {
          const url = firstUrl(output['video_url'])
          if (url === undefined) return { failed: 'Wan 3.0 task succeeded without a video URL.' }
          return { url }
        }
        case 'FAILED':
          return { failed: errorText(output['message'] ?? poll['message'] ?? 'Wan 3.0 video generation failed') }
        case 'CANCELED':
          return { failed: 'Wan 3.0 task was cancelled.' }
        case 'UNKNOWN':
          return { failed: 'Wan 3.0 task not found or past its query window.' }
        default:
          return {}
      }
    }, { intervalMs }, startedAt, deadline, signal)
  }

  if (outcome === '') throw new Error('Vendor finished without an asset URL')
  return [await downloadAsBase64(fetchImpl, outcome, signal)]
}

/** Volcengine Seedream image: synchronous or a short task poll, then download. */
export async function generateVolcengineImage(
  key: string,
  entry: MediaCatalogEntry,
  request: { prompt: string; size?: string },
  timeoutMs: number,
  signal: AbortSignal,
  deps: PollingProviderDeps = {},
): Promise<VendorMediaResult[]> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const intervalMs = deps.intervalMs ?? POLL_INTERVAL_MS
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  const headers = { Authorization: `Bearer ${key}` }

  const body: Record<string, unknown> = { model: entry.model, prompt: request.prompt }
  const size = request.size?.match(/^(\d+)x(\d+)$/)
  if (size) {
    body.width = Number(size[1])
    body.height = Number(size[2])
  }
  const submitted = await postJson(fetchImpl, `${VOLCENGINE_BASE}/api/v3/images/generations`, headers, body, signal)

  let url = firstUrl((submitted['data'] as any)?.[0]?.url, submitted['url'])
  if (url === undefined) {
    const taskId = firstUrl(submitted['task_id'], submitted['id'])
    if (taskId === undefined) throw new Error('Vendor returned neither an image URL nor a task id')
    const image = await pollUntilDone(async () => {
      const poll = await getJson(fetchImpl, `${VOLCENGINE_BASE}/api/v3/images/generations/${taskId}`, headers, signal)
      if (poll['status'] === 'succeeded') {
        return { url: firstUrl((poll['data'] as any)?.[0]?.url, poll['image_url']) }
      }
      if (poll['status'] === 'failed') return { failed: errorText(poll['error'] ?? 'Image generation failed') }
      return {}
    }, { intervalMs }, startedAt, deadline, signal)
    url = image
  }
  const asset = await downloadAsBase64(fetchImpl, url, signal)
  return [{ ...asset, media_type: asset.media_type.startsWith('image/') ? asset.media_type : 'image/png' }]
}
