/**
 * 公司后端（bot-backend）视频生成 Adapter — 走 /api/media/video。
 *
 * 响应为同步 JSON（{ok, videos: [{media_type, base64}]}）：base64 解码为
 * data URL 交给 handleVideoComplete 的下载通路（Node fetch 支持 data: URL），
 * 落盘与海报帧提取走既有流程。
 */
import type {
  AIConfig,
  ProviderRequest,
  VideoGenResponse,
  VideoGenerationRecord,
  VideoPollResponse,
  VideoProviderAdapter,
} from './types'

export class CompanyVideoAdapter implements VideoProviderAdapter {
  provider = 'company'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const body: Record<string, unknown> = {
      model: record.model || config.model || 'default',
      prompt: record.prompt || '',
    }
    if (record.aspectRatio) body.aspectRatio = record.aspectRatio
    if (record.resolution) body.resolution = record.resolution
    if (record.duration != null) body.duration = Number(record.duration)
    if (record.seed != null) body.seed = Number(record.seed)
    if (record.generateAudio != null) body.generateAudio = Number(record.generateAudio) === 1
    if (record.imageUrl) body.imageUrl = record.imageUrl
    return {
      url: `${config.baseUrl.replace(/\/+$/, '')}/api/media/video`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const videos = result?.videos
    const first = Array.isArray(videos) ? videos[0] : null
    const base64 = typeof first?.base64 === 'string' ? first.base64 : null
    const mediaType = typeof first?.media_type === 'string' ? first.media_type : 'video/mp4'
    if (!base64) return { isAsync: false }
    // base64 → data URL：handleVideoComplete 的 downloadFile（undici fetch）原生支持
    return { isAsync: false, videoUrl: `data:${mediaType};base64,${base64}` }
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    throw new Error('公司媒体接口为同步返回，不支持轮询')
  }

  parsePollResponse(result: any): VideoPollResponse {
    return { status: 'failed', error: '公司媒体接口为同步返回' }
  }

  extractVideoUrl(result: any): string | null {
    return null
  }
}
