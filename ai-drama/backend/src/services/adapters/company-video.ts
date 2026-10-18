/**
 * 公司后端（bot-backend）视频生成 Adapter — 走 /api/media/video。
 *
 * 响应为同步 JSON（{ok, videos: [{media_type, base64}]}）：base64 解码为
 * data URL 交给 handleVideoComplete 的下载通路（Node fetch 支持 data: URL），
 * 落盘与海报帧提取走既有流程。
 *
 * 参考素材字段（帧图/参考视频/音频/文件/链接）按公司契约以 JSON 数组下发，
 * 轮询由公司后端内化，本侧同步等待结果。
 */
import type {
  AIConfig,
  ProviderRequest,
  VideoGenResponse,
  VideoGenerationRecord,
  VideoPollResponse,
  VideoProviderAdapter,
} from './types'

/** 历史任务把参考列存成 JSON 字符串（数组或单值），这里归一为数组。 */
function referenceList(value: string | null | undefined): string[] {
  const raw = String(value || '').trim()
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string' && !!v.trim())
  } catch { /* 单个裸 URL */ }
  return [raw]
}

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
    // 任务侧以 0/1 存储；契约要布尔，仅显式 false 关闭音频
    if (record.generateAudio != null) body.generateAudio = Number(record.generateAudio) !== 0 && record.generateAudio !== false
    if (record.imageUrl) body.imageUrl = record.imageUrl
    if (record.firstFrameUrl) body.firstFrameUrl = record.firstFrameUrl
    if (record.lastFrameUrl) body.lastFrameUrl = record.lastFrameUrl
    const referenceImages = referenceList(record.referenceImageUrls)
    if (referenceImages.length) body.referenceImages = referenceImages
    const referenceVideos = referenceList(record.referenceVideoUrls)
    if (referenceVideos.length) body.referenceVideos = referenceVideos
    const referenceAudios = referenceList(record.referenceAudioUrls)
    if (referenceAudios.length) body.referenceAudios = referenceAudios
    if (record.referenceFileUrl) body.referenceFileUrl = record.referenceFileUrl
    if (record.referenceLinkUrl) body.referenceLinkUrl = record.referenceLinkUrl
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
