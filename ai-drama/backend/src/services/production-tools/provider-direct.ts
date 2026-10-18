import { regionalToolSpecs, runRegional } from './provider-regional.js'
import { klingToolSpecs, runKling } from './provider-kling.js'
import { extraToolSpecs, runExtra } from './provider-extra.js'
import { runMediaProvider, mediaToolSpecs } from './provider-media.js'
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
    model = config.model || directToolSpecs[ctx.toolId as keyof typeof directToolSpecs]?.model
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
export async function runDirect(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  if (Object.hasOwn(regionalToolSpecs, ctx.toolId)) return runRegional(ctx, deps)
  if (Object.hasOwn(klingToolSpecs, ctx.toolId)) return runKling(ctx, deps)
  if (Object.hasOwn(extraToolSpecs, ctx.toolId)) return runExtra(ctx, deps)
  if (ctx.toolId.endsWith('_tts')) return speech(ctx, deps)
  return runMediaProvider(ctx, deps)
}
