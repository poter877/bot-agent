/** build agent 的贴图生成：同步调用已配置的图片模型，返回图片字节。
 *
 * 复用 drama 管线的图片适配器（openai/gemini/volcengine/aliyun），但不走 sys_task
 * 任务表——agent 工具需要拿到字节直接落盘到影片工程目录。
 * 同时支持同步（URL/base64）与异步（任务轮询）两种厂商形态。
 */
import { getActiveConfig } from '../ai.js'
import { getImageAdapter, imageAdapters } from '../adapters/registry.js'

const POLL_ATTEMPTS = 60
const POLL_INTERVAL_MS = 5_000
const POLL_CAP_MS = 5 * 60_000

export async function hasImageModel(): Promise<boolean> {
  return (await getActiveConfig('image')) !== null
}

/** 生成一张贴图；未配置图片模型时抛出可读错误。 */
export async function generateTextureImage(opts: { prompt: string; size?: string }): Promise<{ bytes: Buffer; mimeType: string }> {
  const config = await getActiveConfig('image')
  if (!config) throw new Error('未配置图片模型：请到「设置」页添加并启用图片 AI 服务（或跳过 generate_texture，用代码材质）')
  if (!imageAdapters[config.provider]) {
    throw new Error(`厂商 ${config.provider} 暂不支持作为贴图来源`)
  }
  const adapter = getImageAdapter(config.provider)
  const record = { id: 0, model: config.model, prompt: opts.prompt, size: opts.size ?? '1536x1536', frameType: null, referenceImages: null }

  const { url, method, headers, body } = adapter.buildGenerateRequest(config, record)
  const isMultipart = body instanceof FormData
  const resp = await fetch(url, {
    method,
    headers,
    body: isMultipart ? (body as FormData) : JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  })
  if (!resp.ok) throw new Error(`图片模型 API error ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
  const result = await resp.json() as unknown

  const gen = adapter.parseGenerateResponse(result)
  if (!gen.isAsync) {
    if (gen.imageUrl) return downloadImage(gen.imageUrl)
    const b64 = adapter.extractImageBase64(result)
    if (b64) return { bytes: Buffer.from(b64.data, 'base64'), mimeType: b64.mimeType || 'image/png' }
    throw new Error('图片模型响应中没有 URL 或 base64 数据')
  }

  // 异步任务：轮询直到完成
  const taskId = gen.taskId
  if (!taskId) throw new Error('图片模型返回异步任务但缺少任务 id')
  const startedAt = Date.now()
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    if (Date.now() - startedAt >= POLL_CAP_MS) throw new Error('贴图生成超时（>5 分钟）')
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    const poll = adapter.buildPollRequest(config, taskId)
    const pr = await fetch(poll.url, {
      method: poll.method,
      headers: poll.headers,
      signal: AbortSignal.timeout(Math.max(1_000, POLL_CAP_MS - (Date.now() - startedAt))),
    })
    if (!pr.ok) continue
    const prBody = await pr.json() as unknown
    const pollResp = adapter.parsePollResponse(prBody) as { status?: string; imageUrl?: string | null }
    if (pollResp.status === 'completed') {
      if (pollResp.imageUrl) return downloadImage(pollResp.imageUrl)
      const b64 = adapter.extractImageBase64(prBody)
      if (b64) return { bytes: Buffer.from(b64.data, 'base64'), mimeType: b64.mimeType || 'image/png' }
      throw new Error('贴图任务完成但响应中没有图片数据')
    }
    if (pollResp.status === 'failed') throw new Error('贴图生成任务失败')
  }
  throw new Error('贴图生成轮询次数用尽')
}

async function downloadImage(url: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!resp.ok) throw new Error(`贴图下载失败 ${resp.status}`)
  const mime = resp.headers.get('content-type')?.split(';')[0] || 'image/png'
  return { bytes: Buffer.from(await resp.arrayBuffer()), mimeType: mime }
}
