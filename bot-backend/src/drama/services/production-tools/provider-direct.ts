import { regionalToolSpecs, runRegional } from './provider-regional.js'
import { assetBytes, assetExtension } from './provider-queue.js'
import { extraToolSpecs, runExtra } from './provider-extra.js'
import { runMediaProvider, mediaToolSpecs } from './provider-media.js'
import { defaultCompanyModel } from '../company-model-catalog.js'
import {
  bearer,
  checkpoint,
  ensureCanSubmit,
  jsonBody,
  jsonRequest,
  num,
  outputBytes,
  required,
  serviceUrl,
  str,
  type ProviderContext,
  type ProviderDependencies,
  type ProviderResult,
} from './provider-runtime.js'
/** 可灵走公司媒体目录（/api/media/image|video）：spec.model 只是默认回落
 *  （配置行/args.model 优先），且默认值即运营目录里的条目 id。厂商 AK/SK
 *  只存在公司后端，本侧仅持内部服务令牌；轮询与产物下载由公司侧内化。 */
export const klingToolSpecs = {
  kling_official_image: {
    serviceType: 'image',
    provider: 'company',
    model: 'kling-v2',
  },
  kling_official_video: {
    serviceType: 'video',
    provider: 'company',
    model: 'kling-v2-6',
  },
  kling_video: {
    serviceType: 'video',
    provider: 'company',
    model: 'kling-v2-6',
  },
} as const
export const directToolSpecs = {
  /** 公司语音合成：走 {COMPANY}/api/media/speech，模型为公司目录 id。 */
  company_tts: {
    serviceType: 'speech',
    provider: 'company',
    model: 'default',
  },
  ...mediaToolSpecs,
  ...extraToolSpecs,
  ...klingToolSpecs,
  ...regionalToolSpecs,
} as const
function base64Audio(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > 140 * 1024 * 1024 ||
    !/^[A-Za-z0-9+/=\r\n]+$/.test(value)
  )
    throw new Error('语音服务未返回有效音频')
  return Buffer.from(value, 'base64')
}
/** 公司语音契约：{model, input, voice?, response_format?('mp3'|'wav'), speed?}，
 *  响应 {ok, audio: {media_type, base64}}。 */
async function speech(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  const config = ctx.config!,
    text = required(ctx.args, ['text', 'script', 'prompt'], '朗读文本'),
    // 配置行 model 不再是真相源：company 行回落公司目录默认，工具预设只作最后兜底
    model = config.model
      || (config.provider === 'company' ? ((await defaultCompanyModel('speech')) ?? '') : '')
      || directToolSpecs[ctx.toolId as keyof typeof directToolSpecs]?.model
  if (text.length > 20000) throw new Error('单次朗读文本不能超过 20000 字，请拆分为多个片段')
  const format = str(ctx.args, 'response_format', 'mp3')
  if (!['mp3', 'wav'].includes(format)) throw new Error('语音输出请选择 mp3 或 wav')
  const voice = str(ctx.args, ['voice', 'voice_id'])
  ensureCanSubmit(ctx)
  checkpoint(ctx, {
    submissionStarted: true,
    provider: config.provider,
    configId: config.id,
    model,
  })
  const data = await jsonRequest(ctx, deps, serviceUrl(config, '/api/media/speech'), {
    method: 'POST',
    headers: bearer(config.apiKey),
    body: jsonBody({
      model,
      input: text,
      ...(voice ? { voice } : {}),
      response_format: format,
      speed: num(ctx.args, 'speed', 1, 0.25, 4),
    }),
  })
  const mediaType = typeof data.audio?.media_type === 'string' ? data.audio.media_type : `audio/${format}`
  const bytes = base64Audio(data.audio?.base64)
  const file = await outputBytes(ctx, bytes, 'audio', mediaType.includes('wav') ? 'wav' : 'mp3')
  ctx.progress(100)
  return { summary: '配音已生成并保存到项目', files: [file], data: { model } }
}
/** 公司媒体契约：{model, prompt, n|aspectRatio（图）|duration/aspectRatio/
 *  generateAudio/mode/imageUrl（视频）}，响应同步 base64 信封
 *  {ok, images|videos: [{media_type, base64}]}。首图本地文件转 data URI
 *  下发（imageUrl），时长/比例/音频开关由公司侧映射可灵参数。 */
const MEDIA_CALL_TIMEOUT_MS = 720000
const MEDIA_RESPONSE_MAX_BYTES = 1024 * 1024 * 1024;
async function companyMedia(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  const c = ctx.config!,
    spec = klingToolSpecs[ctx.toolId as keyof typeof klingToolSpecs],
    image = spec.serviceType === 'image',
    model = c.model || spec.model,
    prompt = required(ctx.args, ['prompt', 'description'], '生成描述')
  if (prompt.length > 2500) throw new Error('可灵描述最多 2500 字，请缩短后重试')
  const body: Record<string, unknown> = { model, prompt }
  const ratio = str(ctx.args, 'aspect_ratio', '16:9'),
    // 公司契约的比例是 W:H 形态；其它写法交由服务端默认值兜底。
    validRatio = /^\d+:\d+$/.test(ratio) ? ratio : ''
  if (image) {
    body.n = Math.round(num(ctx.args, ['count', 'num_images'], 1, 1, 4))
    if (validRatio) body.aspectRatio = validRatio
  } else {
    const duration = num(ctx.args, 'duration', 5, 5, 10)
    if (duration !== 5 && duration !== 10) throw new Error('此可灵模型的时长请选择 5 秒或 10 秒')
    body.duration = duration
    body.generateAudio = ctx.args.generate_audio !== false
    body.mode = str(ctx.args, 'mode', 'pro')
    const first = str(ctx.args, ['image', 'image_url', 'first_frame'])
    if (first) {
      const file = await deps.readMedia(ctx, first, 'image')
      if (file.bytes.length > 10 * 1024 * 1024) throw new Error('可灵输入图片须小于 10 MB')
      body.imageUrl = `data:${file.mime};base64,${file.bytes.toString('base64')}`
    } else if (validRatio) body.aspectRatio = validRatio
  }
  ensureCanSubmit(ctx)
  checkpoint(ctx, {
    submissionStarted: true,
    provider: c.provider,
    configId: c.id,
    model,
  })
  let data: any
  try {
    data = await jsonRequest(
      ctx,
      deps,
      serviceUrl(c, image ? '/api/media/image' : '/api/media/video'),
      {
        method: 'POST',
        headers: bearer(c.apiKey),
        body: jsonBody(body),
        timeoutMs: MEDIA_CALL_TIMEOUT_MS,
      },
      MEDIA_RESPONSE_MAX_BYTES,
    )
  } catch (error) {
    // 同步事务：请求失败即结果不可恢复（资产不会回投），重试按新任务提交
    checkpoint(ctx, { submissionStarted: false })
    throw error
  }
  const list = Array.isArray(data[image ? 'images' : 'videos']) ? data[image ? 'images' : 'videos'] : []
  if (!list.length) throw new Error('公司媒体服务未返回可灵生成文件')
  const files: ProviderResult['files'] = []
  for (const asset of list.slice(0, 4))
    files.push(
      await outputBytes(
        ctx,
        assetBytes(asset),
        image ? 'image' : 'video',
        assetExtension(asset?.media_type, image ? 'image' : 'video'),
      ),
    )
  checkpoint(ctx, { submissionStarted: false })
  ctx.progress(100)
  return { summary: '可灵媒体生成完成', files, data: { model } }
}
export async function runDirect(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  if (Object.hasOwn(regionalToolSpecs, ctx.toolId)) return runRegional(ctx, deps)
  if (Object.hasOwn(klingToolSpecs, ctx.toolId)) return companyMedia(ctx, deps)
  if (Object.hasOwn(extraToolSpecs, ctx.toolId)) return runExtra(ctx, deps)
  if (ctx.toolId.endsWith('_tts')) return speech(ctx, deps)
  return runMediaProvider(ctx, deps)
}
