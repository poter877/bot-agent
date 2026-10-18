import {
  bearer,
  checkpoint,
  ensureCanSubmit,
  jsonBody,
  jsonRequest,
  mediaDataUri,
  num,
  outputBytes,
  outputJson,
  outputRemote,
  poll,
  required,
  request,
  responseBytes,
  serviceUrl,
  str,
  submitJson,
  type OutputKind,
  type ProviderContext,
  type ProviderDependencies,
  type ProviderResult,
} from './provider-runtime.js'
export const extraToolSpecs = {
  atlas_image: {
    serviceType: 'image',
    provider: 'atlascloud',
    model: 'bytedance/seedream-v5.0-pro/text-to-image',
  },
  atlas_refresh_image: {
    serviceType: 'image',
    provider: 'atlascloud',
    model: 'google/nano-banana-2/text-to-image',
  },
  atlas_video: {
    serviceType: 'video',
    provider: 'atlascloud',
    model: 'google/veo3.1/text-to-video',
  },
  wan_atlas_video: {
    serviceType: 'video',
    provider: 'atlascloud',
    model: 'alibaba/wan-2.7/text-to-video',
  },
  atlas_3d: {
    serviceType: 'model3d',
    provider: 'atlascloud',
    model: 'tripo-h3.1/text-to-3d',
  },
  suno_music: {
    serviceType: 'music',
    provider: 'atlascloud',
    model: 'suno/chirp-v5',
  },
  higgsfield_video: {
    serviceType: 'video',
    provider: 'higgsfield',
    model: 'bytedance/seedance-2.0/text-to-video',
  },
  dashscope_tts: {
    serviceType: 'speech',
    provider: 'dashscope',
    model: 'qwen3-tts-flash',
  },
  dashscope_image: {
    serviceType: 'image',
    provider: 'dashscope',
    model: 'qwen-image-3.0-pro',
  },
  dashscope_asr: {
    serviceType: 'transcription',
    provider: 'dashscope',
    model: 'qwen3-asr-flash',
  },
  google_imagen: {
    serviceType: 'image',
    provider: 'gemini',
    model: 'gemini-2.5-flash-image',
  },
  veo_video: {
    serviceType: 'video',
    provider: 'gemini',
    model: 'veo-3.1-generate-preview',
  },
  google_music: {
    serviceType: 'music',
    provider: 'google',
    model: 'lyria-002',
  },
} as const
async function atlas(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  const c = ctx.config!,
    spec = extraToolSpecs[ctx.toolId as keyof typeof extraToolSpecs],
    kind: OutputKind =
      spec.serviceType === 'model3d'
        ? 'model'
        : spec.serviceType === 'music'
          ? 'audio'
          : (spec.serviceType as OutputKind),
    base = serviceUrl(c, '', '/api/v1/model'),
    headers = bearer(c.apiKey),
    model = spec.model
  if (!ctx.state.remoteId) {
    const body: Record<string, unknown> = {
      model,
      prompt: required(ctx.args, ['prompt', 'description', 'text'], '生成描述'),
    }
    if (kind === 'video') {
      body.duration = Math.round(num(ctx.args, 'duration', 5, 2, 15))
      body.ratio = str(ctx.args, 'aspect_ratio', '16:9')
      body.resolution = str(ctx.args, 'resolution', '720P')
    }
    if (kind === 'audio') {
      body.instrumental = ctx.args.instrumental !== false
      body.custom = false
    }
    const image = str(ctx.args, ['image', 'image_url'])
    if (image) {
      const file = await deps.readMedia(ctx, image, 'image'),
        form = new FormData()
      form.set('file', new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.name)
      const upload = await jsonRequest(ctx, deps, `${base}/uploadMedia`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.apiKey}` },
        body: form,
      })
      const url = upload.url || upload.data?.url
      if (typeof url !== 'string') throw new Error('Atlas 上传未返回素材地址')
      body.image_url = url
    }
    await submitJson(
      ctx,
      deps,
      `${base}/${kind === 'video' ? 'generateVideo' : kind === 'audio' ? 'generateAudio' : 'generateImage'}`,
      body,
      headers,
      (v) => v.data?.id || v.id,
    )
  }
  const data = await poll(
    ctx,
    deps,
    async () => {
      const d = await jsonRequest(
        ctx,
        deps,
        `${base}/prediction/${encodeURIComponent(String(ctx.state.remoteId))}`,
        { headers },
      )
      return d.data || d
    },
    (v) => v.status === 'completed',
    (v) => ['failed', 'timeout', 'cancelled'].includes(v.status),
  )
  const outputs =
    Array.isArray(data.files) && data.files.length ? data.files.map((v: any) => v.url) : data.outputs
  if (!Array.isArray(outputs) || !outputs.length) throw new Error('Atlas 任务未返回文件')
  const files: ProviderResult['files'] = []
  for (const url of outputs.slice(0, 4)) {
    if (typeof url !== 'string' || !url.startsWith('https://')) continue
    const actualKind = kind === 'model' && /\.zip(?:\?|$)/i.test(url) ? 'archive' : kind
    files.push(
      await outputRemote(ctx, deps, url, actualKind, [
        'atlascloud.ai',
        'atlascloud.com',
        'atlascdn.com',
        'atlascloudai.com',
        'amazonaws.com',
        'r2.dev',
        'storage.googleapis.com',
      ]),
    )
  }
  if (!files.length) throw new Error('Atlas 输出没有可用媒体链接')
  ctx.progress(100)
  return {
    summary: 'Atlas Cloud 生成完成',
    files,
    data: { remoteId: ctx.state.remoteId, model },
  }
}
async function higgsfield(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  const c = ctx.config!,
    base = serviceUrl(c, ''),
    headers = {
      Authorization: `Key ${c.apiKey}`,
      'Content-Type': 'application/json',
    },
    model = extraToolSpecs.higgsfield_video.model
  if (!ctx.state.remoteId) {
    if (str(ctx.args, ['image', 'image_url']))
      throw new Error('此 Higgsfield 工具使用文生视频模型；参考图生成请使用对应图生视频工具')
    await submitJson(
      ctx,
      deps,
      `${base}/${model}`,
      {
        prompt: required(ctx.args, ['prompt', 'description'], '生成描述'),
        duration: Math.round(num(ctx.args, 'duration', 5, 4, 15)),
        resolution: str(ctx.args, 'resolution', '720p'),
        aspect_ratio: str(ctx.args, 'aspect_ratio', '16:9'),
        generate_audio: ctx.args.generate_audio !== false,
      },
      headers,
      (v) => v.request_id,
    )
  }
  const data = await poll(
    ctx,
    deps,
    () =>
      jsonRequest(ctx, deps, `${base}/requests/${encodeURIComponent(String(ctx.state.remoteId))}/status`, {
        headers,
      }),
    (v) => v.status === 'completed',
    (v) => ['failed', 'nsfw', 'canceled', 'cancelled'].includes(v.status),
  )
  if (typeof data.video?.url !== 'string') throw new Error('Higgsfield 未返回视频')
  const file = await outputRemote(
    ctx,
    deps,
    data.video.url,
    'video',
    ['higgsfield.ai', 'higgsfield.xyz', 'cloudfront.net', 'amazonaws.com'],
    'mp4',
  )
  ctx.progress(100)
  return {
    summary: 'Higgsfield 视频生成完成',
    files: [file],
    data: { remoteId: ctx.state.remoteId },
  }
}
async function dashscope(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  const c = ctx.config!,
    model = c.model || extraToolSpecs[ctx.toolId as keyof typeof extraToolSpecs].model,
    base = serviceUrl(c, '', '/api/v1'),
    headers = bearer(c.apiKey)
  let body: Record<string, unknown>
  if (ctx.toolId === 'dashscope_tts') {
    const text = required(ctx.args, ['text', 'script', 'prompt'], '朗读文本')
    if (text.length > 600) throw new Error('Qwen TTS 单次最多 600 字，请拆分片段')
    body = {
      model,
      input: {
        text,
        voice: str(ctx.args, ['voice', 'voice_id'], 'Cherry'),
        language_type: str(ctx.args, 'language', 'Auto'),
      },
    }
  } else if (ctx.toolId === 'dashscope_asr') {
    const file = await deps.readMedia(
      ctx,
      required(ctx.args, ['audio', 'audio_url', 'input'], '音频素材'),
      'audio',
    )
    if (file.bytes.length > 10 * 1024 * 1024) throw new Error('Qwen ASR 输入须小于 10 MB 且不超过 5 分钟')
    body = {
      model,
      input: {
        messages: [
          {
            role: 'user',
            content: [
              {
                audio: `data:${file.mime};base64,${file.bytes.toString('base64')}`,
              },
            ],
          },
        ],
      },
      parameters: { asr_options: { enable_itn: true } },
    }
  } else {
    const content: Record<string, string>[] = [
        { text: required(ctx.args, ['prompt', 'description'], '图片描述') },
      ],
      image = str(ctx.args, ['image', 'image_url'])
    if (image) content.unshift({ image: await mediaDataUri(ctx, deps, image, 'image') })
    body = {
      model,
      input: { messages: [{ role: 'user', content }] },
      parameters: {
        size: str(ctx.args, 'size', '1536*1024').replace('x', '*'),
        n: Math.round(num(ctx.args, ['count', 'num_images'], 1, 1, 4)),
        watermark: ctx.args.watermark !== false,
      },
    }
  }
  let data: any = ctx.state.syncResult
  if (!data) {
    ensureCanSubmit(ctx)
    checkpoint(ctx, {
      submissionStarted: true,
      provider: c.provider,
      configId: c.id,
    })
    data = await jsonRequest(ctx, deps, `${base}/services/aigc/multimodal-generation/generation`, {
      method: 'POST',
      headers,
      body: jsonBody(body),
    })
    checkpoint(ctx, { syncResult: data })
  }
  if (data.code || (data.status_code && data.status_code !== 200))
    throw new Error('百炼服务拒绝了请求，请检查地域、模型和参数')
  const files: ProviderResult['files'] = []
  if (ctx.toolId === 'dashscope_tts') {
    let url = data.output?.audio?.url
    if (typeof url !== 'string') throw new Error('Qwen TTS 没有返回配音文件')
    if (url.startsWith('http:')) url = url.replace(/^http:/, 'https:')
    files.push(await outputRemote(ctx, deps, url, 'audio', ['aliyuncs.com'], 'wav'))
  } else if (ctx.toolId === 'dashscope_asr') {
    const content = data.output?.choices?.[0]?.message?.content,
      text = Array.isArray(content) ? content.map((v: any) => v.text || '').join('') : data.output?.text
    if (typeof text !== 'string' || !text) throw new Error('Qwen ASR 没有返回识别文字')
    files.push(await outputJson(ctx, { text, raw: data }, 'transcription.json'))
    return {
      summary: '录音识别完成，此模型返回文字而不提供逐词时码',
      files,
      data: { text },
    }
  } else {
    for (const choice of data.output?.choices || [])
      for (const item of choice.message?.content || [])
        if (item.image)
          files.push(
            await outputRemote(ctx, deps, String(item.image).replace(/^http:/, 'https:'), 'image', [
              'aliyuncs.com',
            ]),
          )
  }
  if (!files.length) throw new Error('百炼服务没有返回可用媒体')
  ctx.progress(100)
  return { summary: '百炼媒体生成完成', files, data: { model } }
}
async function migratedGoogleImage(
  ctx: ProviderContext,
  deps: ProviderDependencies,
): Promise<ProviderResult> {
  const c = ctx.config!,
    model = extraToolSpecs.google_imagen.model,
    base = serviceUrl(c, '', '/v1beta')
  let data: any = ctx.state.syncResult
  if (!data) {
    const parts: any[] = [{ text: required(ctx.args, ['prompt', 'description'], '图片描述') }],
      image = str(ctx.args, ['image', 'image_url'])
    if (image) {
      const f = await deps.readMedia(ctx, image, 'image')
      parts.unshift({
        inlineData: { mimeType: f.mime, data: f.bytes.toString('base64') },
      })
    }
    ensureCanSubmit(ctx)
    checkpoint(ctx, {
      submissionStarted: true,
      provider: c.provider,
      configId: c.id,
    })
    data = await jsonRequest(ctx, deps, `${base}/models/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': c.apiKey,
        'Content-Type': 'application/json',
      },
      body: jsonBody({
        contents: [{ parts }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      }),
    })
    checkpoint(ctx, { syncResult: data })
  }
  const files: ProviderResult['files'] = []
  for (const candidate of data.candidates || [])
    for (const part of candidate.content?.parts || [])
      if (typeof part.inlineData?.data === 'string' && String(part.inlineData?.mimeType).startsWith('image/'))
        files.push(
          await outputBytes(
            ctx,
            Buffer.from(part.inlineData.data, 'base64'),
            'image',
            String(part.inlineData.mimeType).includes('jpeg') ? 'jpg' : 'png',
          ),
        )
  if (!files.length) throw new Error('Google 图像模型未返回图片，请调整描述重试')
  ctx.progress(100)
  return {
    summary: 'Google 图片生成完成；已使用 Nano Banana 替代停用的 Imagen',
    files,
    data: { model, migratedFrom: 'Imagen' },
  }
}
async function google(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  const c = ctx.config!,
    music = ctx.toolId === 'google_music',
    video = ctx.toolId === 'veo_video',
    model = c.model || extraToolSpecs[ctx.toolId as keyof typeof extraToolSpecs].model,
    headers = music ? bearer(c.apiKey) : { 'x-goog-api-key': c.apiKey, 'Content-Type': 'application/json' },
    base = serviceUrl(c, '', music ? '' : '/v1beta')
  let data: any = ctx.state.syncResult
  if (!ctx.state.remoteId && !data) {
    const instance: Record<string, unknown> = {
        prompt: required(ctx.args, ['prompt', 'description'], '生成描述'),
      },
      parameters: Record<string, unknown> = {}
    if (video) {
      parameters.aspectRatio = str(ctx.args, 'aspect_ratio', '16:9')
      parameters.durationSeconds = Math.round(num(ctx.args, 'duration', 8, 4, 8))
      const image = str(ctx.args, ['image', 'image_url', 'first_frame'])
      if (image) {
        const f = await deps.readMedia(ctx, image, 'image')
        instance.image = {
          bytesBase64Encoded: f.bytes.toString('base64'),
          mimeType: f.mime,
        }
      }
    } else if (music) {
      const project = required(ctx.args, 'google_project', 'Google Cloud 项目 ID'),
        location = str(ctx.args, 'location', 'us-central1')
      if (!/^[a-z][a-z0-9-]{4,62}$/.test(project) || !/^[a-z0-9-]+$/.test(location))
        throw new Error('Google Cloud 项目或地域无效')
      parameters.sample_count = 1
      const negative = str(ctx.args, 'negative_prompt')
      if (negative) instance.negative_prompt = negative
      checkpoint(ctx, {
        googleResource: `projects/${project}/locations/${location}/publishers/google`,
      })
    } else {
      parameters.sampleCount = Math.round(num(ctx.args, ['count', 'num_images'], 1, 1, 4))
      parameters.aspectRatio = str(ctx.args, 'aspect_ratio', '16:9')
    }
    const body = { instances: [instance], parameters },
      url = music
        ? `${base}/v1/${ctx.state.googleResource}/models/${encodeURIComponent(model)}:predict`
        : `${base}/models/${encodeURIComponent(model)}:${video ? 'predictLongRunning' : 'predict'}`
    if (video) await submitJson(ctx, deps, url, body, headers, (v) => v.name)
    else {
      ensureCanSubmit(ctx)
      checkpoint(ctx, {
        submissionStarted: true,
        provider: c.provider,
        configId: c.id,
      })
      data = await jsonRequest(ctx, deps, url, {
        method: 'POST',
        headers,
        body: jsonBody(body),
      })
      checkpoint(ctx, { syncResult: data })
    }
  }
  if (video) {
    const resource = String(ctx.state.remoteId)
    if (
      !/^models\/[a-zA-Z0-9_.-]+\/operations\/[a-zA-Z0-9_.-]+$/.test(resource) &&
      !/^operations\/[a-zA-Z0-9_.-]+$/.test(resource)
    )
      throw new Error('Google 视频任务 ID 格式无效')
    data = await poll(
      ctx,
      deps,
      () => jsonRequest(ctx, deps, `${base}/${resource}`, { headers }),
      (v) => v.done === true,
      (v) => !!v.error,
    )
    const uri = data.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
    if (typeof uri !== 'string' || new URL(uri).origin !== new URL(base).origin)
      throw new Error('Google 视频返回的下载地址无效')
    const response = await deps.fetch(uri, {
      headers: { 'x-goog-api-key': c.apiKey },
      redirect: 'manual',
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(300000)]),
    })
    let file
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const target = response.headers.get('location')
      await response.body?.cancel()
      if (!target) throw new Error('Google 下载地址无效')
      file = await outputRemote(
        ctx,
        deps,
        new URL(target, uri).href,
        'video',
        ['googleapis.com', 'googleusercontent.com', 'gvt1.com'],
        'mp4',
      )
    } else {
      if (!response.ok) throw new Error('Google 视频下载失败，请恢复查询')
      file = await outputBytes(ctx, await responseBytes(response, 512 * 1024 * 1024), 'video', 'mp4')
    }
    ctx.progress(100)
    return {
      summary: 'Veo 视频生成完成',
      files: [file],
      data: { remoteId: ctx.state.remoteId },
    }
  }
  const predictions = data.predictions
  if (!Array.isArray(predictions) || !predictions.length) throw new Error('Google 没有返回生成结果')
  const files: ProviderResult['files'] = []
  for (const item of predictions.slice(0, 4)) {
    const raw = music ? item.audioContent : item.bytesBase64Encoded
    if (typeof raw === 'string')
      files.push(
        await outputBytes(ctx, Buffer.from(raw, 'base64'), music ? 'audio' : 'image', music ? 'wav' : 'png'),
      )
  }
  if (!files.length) throw new Error('Google 未返回有效媒体文件')
  ctx.progress(100)
  return {
    summary: music ? 'Lyria 配乐生成完成（30 秒器乐）' : 'Imagen 图片生成完成',
    files,
    data: { model },
  }
}
export async function runExtra(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  if (ctx.toolId === 'google_imagen') return migratedGoogleImage(ctx, deps)
  switch (ctx.config!.provider) {
    case 'atlascloud':
      return atlas(ctx, deps)
    case 'higgsfield':
      return higgsfield(ctx, deps)
    case 'dashscope':
      return dashscope(ctx, deps)
    case 'google':
    case 'gemini':
      return google(ctx, deps)
    default:
      throw new Error('工具没有对应服务适配器')
  }
}
