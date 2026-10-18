import { createHash, createHmac, randomUUID } from 'node:crypto'
import {
  checkpoint,
  ensureCanSubmit,
  jsonBody,
  jsonRequest,
  num,
  outputBytes,
  outputRemote,
  poll,
  required,
  request,
  responseBytes,
  serviceUrl,
  str,
  type ProviderContext,
  type ProviderDependencies,
  type ProviderResult,
} from './provider-runtime.js'
export const regionalToolSpecs = {
  doubao_tts: {
    serviceType: 'speech',
    provider: 'doubao',
    model: 'seed-tts-2.0',
  },
  hunyuan_image: {
    serviceType: 'image',
    provider: 'hunyuan_cloud',
    model: 'hunyuan-image',
  },
  hunyuan_cloud_video: {
    serviceType: 'video',
    provider: 'hunyuan_cloud',
    model: 'hunyuan-video',
  },
} as const
function credentials(key: string) {
  const separator = key.indexOf(':')
  if (separator < 1 || separator === key.length - 1)
    throw new Error('请在腾讯云服务密钥中填写 SecretId:SecretKey')
  return { id: key.slice(0, separator), secret: key.slice(separator + 1) }
}
export function tencentHeaders(
  key: string,
  host: string,
  service: string,
  action: string,
  version: string,
  region: string,
  body: string,
  millis = Date.now(),
) {
  const cred = credentials(key),
    seconds = Math.floor(millis / 1000),
    date = new Date(seconds * 1000).toISOString().slice(0, 10),
    contentType = 'application/json; charset=utf-8',
    signed = 'content-type;host',
    hash = (v: string) => createHash('sha256').update(v).digest('hex'),
    hmac = (key: string | Buffer, v: string) => createHmac('sha256', key).update(v).digest()
  const canonical = `POST\n/\n\ncontent-type:${contentType}\nhost:${host}\n\n${signed}\n${hash(body)}`,
    scope = `${date}/${service}/tc3_request`,
    toSign = `TC3-HMAC-SHA256\n${seconds}\n${scope}\n${hash(canonical)}`,
    signature = createHmac('sha256', hmac(hmac(hmac(`TC3${cred.secret}`, date), service), 'tc3_request'))
      .update(toSign)
      .digest('hex')
  return {
    Authorization: `TC3-HMAC-SHA256 Credential=${cred.id}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
    'Content-Type': contentType,
    Host: host,
    'X-TC-Action': action,
    'X-TC-Timestamp': String(seconds),
    'X-TC-Version': version,
    'X-TC-Region': region,
  }
}
async function tencent(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  const c = ctx.config!,
    video = ctx.toolId === 'hunyuan_cloud_video',
    service = video ? 'vclm' : 'hunyuan',
    version = video ? '2024-05-23' : '2023-09-01',
    origin = new URL(serviceUrl(c, '')),
    region = str(ctx.args, 'region', 'ap-guangzhou')
  // The image and video APIs share Tencent credentials, with distinct documented product origins.
  if (
    !['hunyuan.tencentcloudapi.com', 'vclm.tencentcloudapi.com'].includes(origin.hostname) ||
    origin.pathname !== '/'
  )
    throw new Error('腾讯云混元服务须使用官方 API 根地址')
  origin.hostname = `${service}.tencentcloudapi.com`
  const call = async (action: string, payload: unknown) => {
    const body = jsonBody(payload),
      headers = tencentHeaders(c.apiKey, origin.hostname, service, action, version, region, body),
      data = await jsonRequest(ctx, deps, origin.href, {
        method: 'POST',
        headers,
        body,
      })
    if (data.Response?.Error) {
      if (action.startsWith('Submit')) checkpoint(ctx, { rejected: true })
      throw new Error('服务拒绝腾讯云混元请求，请检查密钥、地域、参数和额度')
    }
    return data.Response
  }
  if (!ctx.state.remoteId) {
    credentials(c.apiKey)
    const prompt = required(ctx.args, ['prompt', 'description'], '生成描述')
    if (prompt.length > (video ? 200 : 1024))
      throw new Error(`当前混元接口描述最多 ${video ? 200 : 1024} 字符`)
    const body: Record<string, unknown> = { Prompt: prompt }
    if (video) {
      body.Resolution = '720p'
      const duration = ctx.args.duration
      if (duration !== undefined && Number(duration) !== 5)
        throw new Error('当前混元云视频接口固定生成 5 秒，请选择 5 秒')
    } else {
      body.Num = Math.round(num(ctx.args, ['count', 'num_images'], 1, 1, 4))
      body.Resolution = str(
        ctx.args,
        'size',
        str(ctx.args, 'aspect_ratio', '16:9') === '9:16' ? '720:1280' : '1280:720',
      ).replace('x', ':')
      const negative = str(ctx.args, 'negative_prompt')
      if (negative) body.NegativePrompt = negative
    }
    const image = str(ctx.args, ['image', 'image_url'])
    if (image) {
      const file = await deps.readMedia(ctx, image, 'image')
      if (file.bytes.length > 6 * 1024 * 1024) throw new Error('混元参考图编码后须小于 8 MB，请先压缩')
      body[video ? 'Image' : 'ContentImage'] = {
        Base64: file.bytes.toString('base64'),
      }
    }
    ensureCanSubmit(ctx)
    checkpoint(ctx, {
      submissionStarted: true,
      provider: c.provider,
      configId: c.id,
      model: c.model,
    })
    const data = await call(video ? 'SubmitHunyuanToVideoJob' : 'SubmitHunyuanImageJob', body)
    if (typeof data?.JobId !== 'string') throw new Error('服务未返回腾讯云任务 ID，请在控制台核对后恢复')
    checkpoint(ctx, { remoteId: data.JobId })
  }
  const data = await poll(
      ctx,
      deps,
      () =>
        call(video ? 'DescribeHunyuanToVideoJob' : 'QueryHunyuanImageJob', {
          JobId: ctx.state.remoteId,
        }),
      (v) => (video ? v.Status === 'DONE' : String(v.JobStatusCode) === '5'),
      (v) => (video ? v.Status === 'FAIL' : String(v.JobStatusCode) === '4'),
    ),
    urls = video ? [data.ResultVideoUrl] : data.ResultImage
  if (!Array.isArray(urls) || !urls.length) throw new Error('服务未返回混元媒体文件')
  const files: ProviderResult['files'] = []
  for (const url of urls.slice(0, 4))
    if (typeof url === 'string')
      files.push(
        await outputRemote(
          ctx,
          deps,
          url,
          video ? 'video' : 'image',
          ['myqcloud.com', 'tencentcos.cn', 'tencentcloudapi.com', 'tencent.com'],
          video ? 'mp4' : undefined,
        ),
      )
  if (!files.length) throw new Error('服务未返回混元产物')
  ctx.progress(100)
  return {
    summary: '腾讯云混元生成完成',
    files,
    data: { remoteId: ctx.state.remoteId },
  }
}
async function doubao(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  const c = ctx.config!,
    text = required(ctx.args, ['text', 'script', 'prompt'], '配音文字')
  if (text.length > 10000) throw new Error('豆包单次文字请控制在 10000 字内')
  ensureCanSubmit(ctx)
  checkpoint(ctx, {
    submissionStarted: true,
    provider: c.provider,
    configId: c.id,
  })
  const response = await request(ctx, deps, serviceUrl(c, '/api/v3/tts/unidirectional'), {
    method: 'POST',
    headers: {
      'X-Api-Key': c.apiKey,
      'X-Api-Resource-Id': c.model || 'seed-tts-2.0',
      'X-Api-Request-Id': randomUUID(),
      'Content-Type': 'application/json',
    },
    body: jsonBody({
      req_params: {
        text,
        speaker: str(ctx.args, ['voice', 'voice_id', 'speaker'], 'zh_female_vv_uranus_bigtts'),
        audio_params: { format: 'mp3', sample_rate: 24000 },
      },
    }),
  })
  const raw = (await responseBytes(response, 100 * 1024 * 1024)).toString('utf8'),
    chunks: Buffer[] = []
  // The HTTP API returns JSON records, sometimes one record, sometimes newline-delimited chunks.
  let records: any[]
  try {
    records = [JSON.parse(raw)]
  } catch {
    try {
      records = raw
        .split(/\r?\n/)
        .filter((v) => v.trim())
        .map((line) => JSON.parse(line.replace(/^data:\s*/, '')))
    } catch {
      throw new Error('服务返回了无效的豆包语音数据')
    }
  }
  for (const item of records) {
    if (item.code !== 0 && item.code !== 20000000) {
      if (!chunks.length) checkpoint(ctx, { rejected: true })
      throw new Error('服务拒绝豆包配音请求，请检查密钥、资源版本和音色权限')
    }
    if (typeof item.data === 'string' && item.data) chunks.push(Buffer.from(item.data, 'base64'))
  }
  if (!chunks.length) throw new Error('服务未返回豆包音频')
  const file = await outputBytes(ctx, Buffer.concat(chunks), 'audio', 'mp3')
  ctx.progress(100)
  return { summary: '豆包配音已生成', files: [file] }
}
export async function runRegional(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  return ctx.toolId === 'doubao_tts' ? doubao(ctx, deps) : tencent(ctx, deps)
}
