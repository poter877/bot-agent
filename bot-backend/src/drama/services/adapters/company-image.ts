/**
 * 公司后端（bot-backend）图片生成 Adapter — 走 /api/media/image。
 *
 * 统一后端入口：厂商密钥只存在于公司后端服务端，本侧只持内部服务令牌
 * （配置 ``apiKey`` = MEDIA_SERVICE_TOKEN）。响应为同步 JSON
 * （{ok, images: [{media_type, base64}]}），经 extractImageBase64 交给
 * generation.ts 的 base64 落盘通路（Gemini 先例）。
 */
import type {
  AIConfig,
  ImageGenResponse,
  ImageGenerationRecord,
  ImagePollResponse,
  ImageProviderAdapter,
  ProviderRequest,
} from './types.js'

export class CompanyImageAdapter implements ImageProviderAdapter {
  provider = 'company'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    return {
      url: `${config.baseUrl.replace(/\/+$/, '')}/api/media/image`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: {
        model: record.model || config.model || 'default',
        prompt: record.prompt || '',
        n: 1,
        ...(record.size ? { size: record.size } : {}),
      },
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    // 同步 base64 通路：extractImageBase64 负责取数
    return { isAsync: false }
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    throw new Error('公司媒体接口为同步返回，不支持轮询')
  }

  parsePollResponse(result: any): ImagePollResponse {
    return { status: 'failed', error: '公司媒体接口为同步返回' }
  }

  extractImageUrl(result: any): string | null {
    return null
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    const images = result?.images
    if (!Array.isArray(images) || images.length === 0) return null
    const first = images[0]
    if (typeof first?.base64 !== 'string' || first.base64 === '') return null
    return { data: first.base64, mimeType: typeof first.media_type === 'string' ? first.media_type : 'image/png' }
  }
}
