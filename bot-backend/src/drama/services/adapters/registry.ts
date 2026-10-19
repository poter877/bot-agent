/**
 * Provider Adapter 注册表
 *
 * 厂商直连已下线：图片/视频唯一适配路径是公司后端（bot-backend）。
 * 历史遗留 provider 的任务不在此回落——迁移已把活跃配置行归一为 company，
 * 白名单之外的值进入 generation.ts 的扩展工具路径并显式报错。
 */
import { CompanyImageAdapter } from './company-image.js'
import { CompanyVideoAdapter } from './company-video.js'
import type { ImageProviderAdapter, VideoProviderAdapter } from './types.js'

// 图片 Adapter 注册表
export const imageAdapters: Record<string, ImageProviderAdapter> = {
  company: new CompanyImageAdapter(),
}

// 视频 Adapter 注册表
export const videoAdapters: Record<string, VideoProviderAdapter> = {
  company: new CompanyVideoAdapter(),
}

/**
 * 获取图片 Adapter
 * @param provider 厂商名称
 * @returns 对应的 Adapter
 */
export function getImageAdapter(provider: string): ImageProviderAdapter {
  const adapter = imageAdapters[provider.toLowerCase()]
  if (!adapter) throw new Error(`Unsupported image provider: ${provider}`)
  return adapter
}

/**
 * 获取视频 Adapter
 * @param provider 厂商名称
 * @returns 对应的 Adapter
 */
export function getVideoAdapter(provider: string): VideoProviderAdapter {
  const adapter = videoAdapters[provider.toLowerCase()]
  if (!adapter) throw new Error(`Unsupported video provider: ${provider}`)
  return adapter
}
