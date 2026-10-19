/** build agent 的贴图生成：同步调用已配置的图片模型，返回图片字节。
 *
 * 走公司后端 /api/media/image（同步 base64 JSON），但不走 sys_task
 * 任务表——agent 工具需要拿到字节直接落盘到影片工程目录。
 */
import { getActiveConfig } from '../ai.js'
import { getImageAdapter, imageAdapters } from '../adapters/registry.js'
import { defaultCompanyModel } from '../company-model-catalog.js'

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
  // 配置行 model 不再是真相源：company 行空模型回落公司图片目录默认
  const model = config.model || (config.provider === 'company' ? ((await defaultCompanyModel('image')) ?? '') : '')
  const record = { id: 0, model, prompt: opts.prompt, size: opts.size ?? '1536x1536', frameType: null, referenceImages: null }

  const { url, method, headers, body } = adapter.buildGenerateRequest(config, record)
  const resp = await fetch(url, {
    method,
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  })
  if (!resp.ok) throw new Error(`图片模型 API error ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
  const result = await resp.json() as unknown

  const b64 = adapter.extractImageBase64(result)
  if (!b64) throw new Error('图片模型响应中没有 base64 图片数据')
  return { bytes: Buffer.from(b64.data, 'base64'), mimeType: b64.mimeType || 'image/png' }
}
