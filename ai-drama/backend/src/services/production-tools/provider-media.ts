import {
  bearer,
  checkpoint,
  ensureCanSubmit,
  jsonBody,
  jsonRequest,
  mediaDataUri,
  num,
  outputBytes,
  outputRemote,
  poll,
  required,
  serviceUrl,
  str,
  submitJson,
  type ProviderContext,
  type ProviderDependencies,
  type ProviderResult,
} from './provider-runtime.js'
export const mediaToolSpecs = {
  grok_image: {
    serviceType: 'image',
    provider: 'grok',
    model: 'grok-imagine-image-2.0',
  },
  grok_video: {
    serviceType: 'video',
    provider: 'grok',
    model: 'grok-imagine-video-1.5',
  },
  ideogram_image: {
    serviceType: 'image',
    provider: 'ideogram',
    model: 'ideogram-3',
  },
  recraft_image: {
    serviceType: 'image',
    provider: 'recraft',
    model: 'recraftv4_1',
  },
  runway_video: { serviceType: 'video', provider: 'runway', model: 'gen4.5' },
  ltx_api_video: {
    serviceType: 'video',
    provider: 'ltx',
    model: 'ltx-2-5-pro',
  },
  heygen_avatar: {
    serviceType: 'avatar',
    provider: 'heygen',
    model: 'avatar_iv',
  },
  heygen_video: {
    serviceType: 'avatar',
    provider: 'heygen',
    model: 'avatar_iv',
  },
} as const
function resumableSync(ctx: ProviderContext) {
  if (ctx.state.syncResult) return ctx.state.syncResult as any
  ensureCanSubmit(ctx)
  return undefined
}
async function grok(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  const c = ctx.config!,
    base = serviceUrl(c, '', '/v1'),
    headers = bearer(c.apiKey),
    video = ctx.toolId === 'grok_video'
  let data: any
  if (!ctx.state.remoteId) {
    data = resumableSync(ctx)
    if (!data) {
      const body: Record<string, unknown> = {
          model: c.model,
          prompt: required(ctx.args, ['prompt', 'description'], '生成描述'),
        },
        image = str(ctx.args, ['image', 'image_url', 'first_frame'])
      if (image)
        body.image = {
          url: await mediaDataUri(ctx, deps, image, 'image'),
          ...(video ? {} : { type: 'image_url' }),
        }
      if (video) {
        body.duration = Math.round(num(ctx.args, 'duration', 6, 1, 15))
        body.aspect_ratio = str(ctx.args, 'aspect_ratio', '16:9')
        body.resolution = str(ctx.args, 'resolution', '720p')
        await submitJson(ctx, deps, `${base}/videos/generations`, body, headers, (v) => v.request_id)
      } else {
        body.n = Math.round(num(ctx.args, ['count', 'num_images'], 1, 1, 4))
        body.response_format = 'b64_json'
        checkpoint(ctx, {
          submissionStarted: true,
          provider: c.provider,
          configId: c.id,
        })
        data = await jsonRequest(ctx, deps, `${base}/images/${image ? 'edits' : 'generations'}`, {
          method: 'POST',
          headers,
          body: jsonBody(body),
        })
        checkpoint(ctx, { syncResult: data })
      }
    }
  }
  if (video)
    data = await poll(
      ctx,
      deps,
      () =>
        jsonRequest(ctx, deps, `${base}/videos/${encodeURIComponent(String(ctx.state.remoteId))}`, {
          headers,
        }),
      (v) => v.status === 'done',
      (v) => ['failed', 'expired'].includes(v.status),
    )
  const files: ProviderResult['files'] = []
  if (video) {
    const url = data.video?.url || data.video?.file_output?.public_url
    if (!url) throw new Error('xAI 未返回视频文件')
    files.push(await outputRemote(ctx, deps, url, 'video', ['x.ai', 'grok.com', 'vidgen.x.ai'], 'mp4'))
  } else
    for (const item of (data.data || []).slice(0, 4)) {
      if (typeof item.b64_json === 'string')
        files.push(await outputBytes(ctx, Buffer.from(item.b64_json, 'base64'), 'image', 'jpg'))
      else if (item.url)
        files.push(await outputRemote(ctx, deps, item.url, 'image', ['x.ai', 'grok.com', 'imgen.x.ai']))
    }
  if (!files.length) throw new Error('xAI 没有返回可用媒体')
  ctx.progress(100)
  return {
    summary: 'Grok 媒体生成完成',
    files,
    data: { remoteId: ctx.state.remoteId },
  }
}
async function ideogram(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  const c = ctx.config!,
    base = serviceUrl(c, '', '/v2'),
    headers = { 'Api-Key': c.apiKey, 'Content-Type': 'application/json' },
    model = c.model || 'ideogram-3'
  if (!['ideogram-3', 'ideogram-4', 'ideogram-4-5'].includes(model))
    throw new Error('Ideogram 模型须使用 ideogram-3、ideogram-4 或 ideogram-4-5')
  if (!ctx.state.remoteId)
    await submitJson(
      ctx,
      deps,
      `${base}/image/generate/${model}`,
      {
        prompt: required(ctx.args, ['prompt', 'description'], '生成描述'),
        aspect_ratio: str(ctx.args, 'aspect_ratio', '16x9').replace(':', 'x'),
        num_images: Math.round(num(ctx.args, ['count', 'num_images'], 1, 1, 4)),
        async: true,
      },
      headers,
      (v) => v.generation_id,
    )
  const data = await poll(
    ctx,
    deps,
    () =>
      jsonRequest(ctx, deps, `${base}/generations/${encodeURIComponent(String(ctx.state.remoteId))}`, {
        headers,
      }),
    (v) => v.status === 'completed',
    (v) => v.status === 'failed',
  )
  const files: ProviderResult['files'] = []
  for (const item of (data.data || []).slice(0, 4))
    if (item.is_image_safe !== false && typeof item.url === 'string')
      files.push(await outputRemote(ctx, deps, item.url, 'image', ['ideogram.ai']))
  if (!files.length) throw new Error('Ideogram 未返回可用图片')
  ctx.progress(100)
  return {
    summary: 'Ideogram 图片生成完成',
    files,
    data: { remoteId: ctx.state.remoteId },
  }
}
async function recraft(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  const c = ctx.config!
  let data = resumableSync(ctx)
  if (!data) {
    const body = {
      prompt: required(ctx.args, ['prompt', 'description'], '生成描述'),
      model: c.model,
      size: str(ctx.args, 'size', '1024x1024'),
      n: Math.round(num(ctx.args, ['count', 'num_images'], 1, 1, 4)),
      response_format: 'url',
    }
    checkpoint(ctx, {
      submissionStarted: true,
      provider: c.provider,
      configId: c.id,
    })
    data = await jsonRequest(ctx, deps, serviceUrl(c, '/images/generations', '/v1'), {
      method: 'POST',
      headers: bearer(c.apiKey),
      body: jsonBody(body),
    })
    checkpoint(ctx, { syncResult: data })
  }
  const files: ProviderResult['files'] = []
  for (const item of (data.data || []).slice(0, 4))
    if (item.url)
      files.push(
        await outputRemote(ctx, deps, item.url, 'image', [
          'recraft.ai',
          'recraft.io',
          'recraft-image-storage.s3.eu-central-1.amazonaws.com',
        ]),
      )
  if (!files.length) throw new Error('Recraft 未返回图片')
  ctx.progress(100)
  return { summary: 'Recraft 图片生成完成', files }
}
async function runway(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  const c = ctx.config!,
    base = serviceUrl(c, '', '/v1'),
    headers = { ...bearer(c.apiKey), 'X-Runway-Version': '2024-11-06' }
  if (!ctx.state.remoteId) {
    const body: Record<string, unknown> = {
        model: c.model,
        promptText: required(ctx.args, ['prompt', 'description'], '生成描述'),
        ratio: str(
          ctx.args,
          'ratio',
          str(ctx.args, 'aspect_ratio', '16:9') === '9:16' ? '720:1280' : '1280:720',
        ),
        duration: num(ctx.args, 'duration', 5, 2, 10),
      },
      image = str(ctx.args, ['image', 'image_url', 'first_frame'])
    if (image) body.promptImage = await mediaDataUri(ctx, deps, image, 'image')
    await submitJson(ctx, deps, `${base}/image_to_video`, body, headers, (v) => v.id)
  }
  const data = await poll(
      ctx,
      deps,
      () =>
        jsonRequest(ctx, deps, `${base}/tasks/${encodeURIComponent(String(ctx.state.remoteId))}`, {
          headers,
        }),
      (v) => v.status === 'SUCCEEDED',
      (v) => ['FAILED', 'CANCELLED'].includes(v.status),
    ),
    urls = data.output
  if (!Array.isArray(urls) || typeof urls[0] !== 'string') throw new Error('Runway 未返回视频')
  const file = await outputRemote(
    ctx,
    deps,
    urls[0],
    'video',
    ['runwayml.com', 'cloudfront.net', 'runwayml.com.cdn.cloudflare.net'],
    'mp4',
  )
  ctx.progress(100)
  return {
    summary: 'Runway 视频生成完成',
    files: [file],
    data: { remoteId: ctx.state.remoteId },
  }
}
async function ltx(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  const c = ctx.config!,
    base = serviceUrl(c, '', '/v2'),
    headers = bearer(c.apiKey),
    image = str(ctx.args, ['image', 'image_url', 'first_frame']),
    endpoint = String(ctx.state.endpoint || (image ? 'image-to-video' : 'text-to-video'))
  if (!['image-to-video', 'text-to-video'].includes(endpoint)) throw new Error('保存的 LTX 任务类型无效')
  if (!ctx.state.remoteId) {
    const body: Record<string, unknown> = {
      prompt: required(ctx.args, ['prompt', 'description'], '生成描述'),
      model: c.model,
      duration: num(ctx.args, 'duration', 8, 2, 20),
      resolution: str(ctx.args, 'resolution', '1920x1080'),
    }
    if (image) body.image_uri = await mediaDataUri(ctx, deps, image, 'image')
    checkpoint(ctx, { endpoint })
    await submitJson(ctx, deps, `${base}/${endpoint}`, body, headers, (v) => v.id)
  }
  const data = await poll(
      ctx,
      {
        ...deps,
        sleep: (ms, signal) => deps.sleep(Math.max(5000, ms), signal),
      },
      () =>
        jsonRequest(ctx, deps, `${base}/${endpoint}/${encodeURIComponent(String(ctx.state.remoteId))}`, {
          headers,
        }),
      (v) => v.status === 'completed',
      (v) => v.status === 'failed',
    ),
    url = data.result?.video_url
  if (typeof url !== 'string') throw new Error('LTX 未返回视频')
  const file = await outputRemote(
    ctx,
    deps,
    url,
    'video',
    ['ltx.io', 'ltx.video', 'storage.googleapis.com'],
    'mp4',
  )
  ctx.progress(100)
  return {
    summary: 'LTX 视频生成完成',
    files: [file],
    data: { remoteId: ctx.state.remoteId },
  }
}
async function heygen(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  const c = ctx.config!,
    base = serviceUrl(c, '', '/v3'),
    headers = { 'x-api-key': c.apiKey, 'Content-Type': 'application/json' }
  if (!ctx.state.remoteId) {
    const body: Record<string, unknown> = {
      script: required(ctx.args, ['text', 'script', 'prompt'], '数字人口播脚本'),
      voice_id: required(ctx.args, ['voice_id', 'voice'], 'HeyGen 声音 ID'),
      aspect_ratio: str(ctx.args, 'aspect_ratio', 'auto'),
      resolution: str(ctx.args, 'resolution', '1080p'),
      engine: { type: c.model || 'avatar_iv' },
    }
    const image = str(ctx.args, ['image', 'image_url', 'portrait'])
    if (image) {
      const f = await deps.readMedia(ctx, image, 'image')
      if (f.bytes.length > 16 * 1024 * 1024) throw new Error('HeyGen 图片输入须小于 16 MB')
      body.type = 'image'
      body.image = {
        type: 'base64',
        media_type: f.mime,
        data: f.bytes.toString('base64'),
      }
    } else {
      body.type = 'avatar'
      body.avatar_id = required(ctx.args, 'avatar_id', 'HeyGen 数字人 ID')
    }
    const motion = str(ctx.args, 'motion_prompt')
    if (motion) body.motion_prompt = motion
    await submitJson(ctx, deps, `${base}/videos`, body, headers, (v) => v.data?.video_id)
  }
  const data = await poll(
    ctx,
    deps,
    async () => {
      const d = await jsonRequest(
        ctx,
        deps,
        `${base}/videos/${encodeURIComponent(String(ctx.state.remoteId))}`,
        { headers },
      )
      return d.data || d
    },
    (v) => v.status === 'completed',
    (v) => v.status === 'failed',
  )
  if (typeof data.video_url !== 'string') throw new Error('HeyGen 未返回视频')
  const files: ProviderResult['files'] = [
    await outputRemote(
      ctx,
      deps,
      data.video_url,
      'video',
      ['heygen.com', 'heygen.ai', 'movio.la', 'amazonaws.com'],
      'mp4',
    ),
  ]
  if (typeof data.subtitle_url === 'string')
    files.push(
      await outputRemote(
        ctx,
        deps,
        data.subtitle_url,
        'subtitle',
        ['heygen.com', 'heygen.ai', 'movio.la', 'amazonaws.com'],
        'srt',
      ),
    )
  ctx.progress(100)
  return {
    summary: '数字人口播视频生成完成',
    files,
    data: { remoteId: ctx.state.remoteId, duration: data.duration },
  }
}
export async function runMediaProvider(
  ctx: ProviderContext,
  deps: ProviderDependencies,
): Promise<ProviderResult> {
  switch (ctx.config!.provider) {
    case 'grok':
      return grok(ctx, deps)
    case 'ideogram':
      return ideogram(ctx, deps)
    case 'recraft':
      return recraft(ctx, deps)
    case 'runway':
      return runway(ctx, deps)
    case 'ltx':
      return ltx(ctx, deps)
    case 'heygen':
      return heygen(ctx, deps)
    default:
      throw new Error('此服务商尚无已验证的媒体生成接口')
  }
}
