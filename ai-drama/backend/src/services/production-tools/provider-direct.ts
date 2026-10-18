import { regionalToolSpecs, runRegional } from './provider-regional.js'
import { klingToolSpecs, runKling } from './provider-kling.js'
import { extraToolSpecs, runExtra } from './provider-extra.js'
import { getImageAdapter, getVideoAdapter } from '../adapters/registry.js'
import { runMediaProvider, mediaToolSpecs } from './provider-media.js'
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
  type ProviderContext,
  type ProviderDependencies,
  type ProviderResult,
  xml,
} from './provider-runtime.js'
export const directToolSpecs = {
  openai_tts: {
    serviceType: 'speech',
    provider: 'openai',
    model: 'gpt-4o-mini-tts',
  },
  elevenlabs_tts: {
    serviceType: 'speech',
    provider: 'elevenlabs',
    model: 'eleven_multilingual_v2',
  },
  music_gen: {
    serviceType: 'music',
    provider: 'elevenlabs',
    model: 'music_v1',
  },
  cartesia_tts: {
    serviceType: 'speech',
    provider: 'cartesia',
    model: 'sonic-3',
  },
  fish_audio_tts: {
    serviceType: 'speech',
    provider: 'fish_audio',
    model: 's2.1-pro',
  },
  inworld_tts: {
    serviceType: 'speech',
    provider: 'inworld',
    model: 'inworld-tts-2',
  },
  gemini_tts: {
    serviceType: 'speech',
    provider: 'gemini',
    model: 'gemini-2.5-flash-preview-tts',
  },
  google_tts: {
    serviceType: 'speech',
    provider: 'google_tts',
    model: 'en-US-Chirp3-HD-Kore',
  },
  azure_tts: {
    serviceType: 'speech',
    provider: 'azure',
    model: 'zh-CN-XiaoxiaoNeural',
  },
  azure_stt: {
    serviceType: 'transcription',
    provider: 'azure',
    model: 'recognition-conversation',
  },
  openai_image: {
    serviceType: 'image',
    provider: 'openai',
    model: 'gpt-image-2',
  },
  seedream_image: {
    serviceType: 'image',
    provider: 'volcengine',
    model: 'doubao-seedream-5-0-260128',
  },
  minimax_video: {
    serviceType: 'video',
    provider: 'minimax',
    model: 'MiniMax-H3',
  },
  seedance_ark: {
    serviceType: 'video',
    provider: 'volcengine',
    model: 'doubao-seedance-2-0-260128',
  },
  seedance_video: {
    serviceType: 'video',
    provider: 'volcengine',
    model: 'doubao-seedance-2-0-260128',
  },
  jimeng_video: {
    serviceType: 'video',
    provider: 'volcengine',
    model: 'doubao-seedance-2-0-260128',
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
function pcmWav(pcm: Buffer, rate = 24000) {
  const header = Buffer.alloc(44)
  header.write('RIFF')
  header.writeUInt32LE(pcm.length + 36, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
async function speech(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  const config = ctx.config!,
    text = required(ctx.args, ['text', 'script', 'prompt'], '朗读文本'),
    model = config.model || directToolSpecs[ctx.toolId as keyof typeof directToolSpecs]?.model
  if (text.length > 20000) throw new Error('单次朗读文本不能超过 20000 字，请拆分为多个片段')
  let url = '',
    headers: Record<string, string> = bearer(config.apiKey),
    body: unknown,
    extension = 'mp3',
    encoding: 'binary' | 'json' = 'binary'
  if (config.provider === 'openai') {
    url = serviceUrl(config, '/audio/speech', '/v1')
    extension = str(ctx.args, 'response_format', 'mp3')
    if (!['mp3', 'wav'].includes(extension)) throw new Error('语音输出请选择 mp3 或 wav')
    body = {
      model,
      input: text,
      voice: str(ctx.args, ['voice', 'voice_id'], 'coral'),
      response_format: str(ctx.args, 'response_format', 'mp3'),
      speed: num(ctx.args, 'speed', 1, 0.25, 4),
    }
  } else if (config.provider === 'elevenlabs') {
    url = serviceUrl(
      config,
      `/text-to-speech/${encodeURIComponent(required(ctx.args, ['voice_id', 'voice'], 'ElevenLabs 声音 ID'))}`,
      '/v1',
    )
    headers = {
      'xi-api-key': config.apiKey,
      'Content-Type': 'application/json',
    }
    body = {
      text,
      model_id: model,
      voice_settings: {
        stability: num(ctx.args, 'stability', 0.5, 0, 1),
        similarity_boost: num(ctx.args, 'similarity_boost', 0.75, 0, 1),
      },
    }
  } else if (config.provider === 'cartesia') {
    url = serviceUrl(config, '/tts/bytes')
    headers = { ...headers, 'Cartesia-Version': '2025-04-16' }
    body = {
      model_id: model,
      transcript: text,
      voice: {
        mode: 'id',
        id: required(ctx.args, ['voice_id', 'voice'], 'Cartesia 声音 ID'),
      },
      output_format: {
        container: 'wav',
        encoding: 'pcm_s16le',
        sample_rate: 44100,
      },
      language: str(ctx.args, 'language', 'zh'),
    }
    extension = 'wav'
  } else if (config.provider === 'fish_audio') {
    url = serviceUrl(config, '/tts', '/v1')
    headers = { ...headers, model }
    body = {
      text,
      reference_id: required(ctx.args, ['voice_id', 'reference_id', 'voice'], 'Fish Audio 声音模型 ID'),
      format: 'mp3',
      prosody: { speed: num(ctx.args, 'speed', 1, 0.5, 2) },
    }
  } else if (config.provider === 'inworld') {
    if (text.length > 2000) throw new Error('Inworld 单次朗读不能超过 2000 字符，请拆分')
    url = serviceUrl(config, '/tts/v1/voice')
    headers = {
      Authorization: `Basic ${config.apiKey}`,
      'Content-Type': 'application/json',
    }
    body = {
      text,
      voiceId: str(ctx.args, ['voice_id', 'voice'], 'Ashley'),
      modelId: model,
      audioConfig: { audioEncoding: 'MP3' },
    }
    encoding = 'json'
  } else if (config.provider === 'google_tts') {
    url = serviceUrl(config, '/text:synthesize', '/v1')
    headers = config.apiKey.startsWith('AIza')
      ? { 'x-goog-api-key': config.apiKey, 'Content-Type': 'application/json' }
      : bearer(config.apiKey)
    body = {
      input: { text },
      voice: {
        name: str(ctx.args, ['voice', 'voice_id'], model),
        languageCode: str(ctx.args, 'language', 'en-US'),
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: num(ctx.args, 'speed', 1, 0.25, 2),
      },
    }
    encoding = 'json'
  } else if (config.provider === 'gemini') {
    url = serviceUrl(config, `/models/${encodeURIComponent(model)}:generateContent`, '/v1beta')
    headers = {
      'x-goog-api-key': config.apiKey,
      'Content-Type': 'application/json',
    }
    body = {
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: str(ctx.args, ['voice', 'voice_id'], 'Kore'),
            },
          },
        },
      },
    }
    encoding = 'json'
    extension = 'wav'
  } else if (config.provider === 'azure') {
    url = serviceUrl(config, '/cognitiveservices/v1')
    headers = {
      'Ocp-Apim-Subscription-Key': config.apiKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-48khz-192kbitrate-mono-mp3',
      'User-Agent': 'VideoFactory',
    }
    body = `<speak version="1.0" xml:lang="${xml(str(ctx.args, 'language', 'zh-CN'))}"><voice name="${xml(str(ctx.args, ['voice', 'voice_id'], model))}">${xml(text)}</voice></speak>`
  } else throw new Error('此语音服务商没有受支持的合成接口')
  ensureCanSubmit(ctx)
  checkpoint(ctx, {
    submissionStarted: true,
    provider: config.provider,
    configId: config.id,
    model,
  })
  let bytes: Buffer
  if (encoding === 'json') {
    const data = await jsonRequest(ctx, deps, url, {
      method: 'POST',
      headers,
      body: jsonBody(body),
    })
    if (config.provider === 'gemini') {
      const part = data.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData?.data)
      bytes = base64Audio(part?.inlineData?.data)
      const rate = Number(String(part?.inlineData?.mimeType || '').match(/rate=(\d+)/)?.[1] || 24000)
      bytes = pcmWav(bytes, rate)
    } else bytes = base64Audio(data.audioContent)
  } else {
    const response = await request(
      ctx,
      deps,
      url,
      {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : jsonBody(body),
      },
      true,
    )
    bytes = await responseBytes(response, 100 * 1024 * 1024)
  }
  const file = await outputBytes(ctx, bytes, 'audio', extension)
  ctx.progress(100)
  return { summary: '配音已生成并保存到项目', files: [file], data: { model } }
}
async function music(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  const config = ctx.config!,
    body = {
      prompt: required(ctx.args, ['prompt', 'description'], '音乐描述'),
      model_id: config.model || 'music_v1',
      music_length_ms: Math.round(num(ctx.args, ['duration', 'duration_seconds'], 30, 3, 600) * 1000),
      force_instrumental: ctx.args.instrumental !== false,
    }
  ensureCanSubmit(ctx)
  checkpoint(ctx, {
    submissionStarted: true,
    provider: config.provider,
    configId: config.id,
  })
  const response = await request(
    ctx,
    deps,
    serviceUrl(config, '/music', '/v1'),
    {
      method: 'POST',
      headers: {
        'xi-api-key': config.apiKey,
        'Content-Type': 'application/json',
      },
      body: jsonBody(body),
    },
    true,
  )
  const file = await outputBytes(ctx, await responseBytes(response, 100 * 1024 * 1024), 'audio', 'mp3')
  ctx.progress(100)
  return {
    summary: '配乐已生成',
    files: [file],
    data: { model: config.model },
  }
}
function timestamp(seconds: number) {
  const ms = Math.round(Math.max(0, seconds) * 1000)
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
}
async function azureStt(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  const config = ctx.config!,
    input = await deps.readMedia(
      ctx,
      required(ctx.args, ['audio', 'audio_url', 'input', 'source'], 'PCM WAV 音频'),
      'audio',
    )
  if (!['audio/wav', 'audio/ogg'].includes(input.mime))
    throw new Error('Azure 短音频识别请上传 16 kHz 单声道 PCM WAV 或 Ogg Opus，且不超过 60 秒')
  const address = new URL(serviceUrl(config, ''))
  address.hostname = address.hostname.replace('.tts.', '.stt.')
  const url = `${address.href.replace(/\/$/, '')}/speech/recognition/conversation/cognitiveservices/v1?${new URLSearchParams({ language: str(ctx.args, 'language', 'zh-CN'), format: 'detailed' })}`
  ensureCanSubmit(ctx)
  checkpoint(ctx, {
    submissionStarted: true,
    provider: config.provider,
    configId: config.id,
  })
  const data = await jsonRequest(ctx, deps, url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': config.apiKey,
      'Content-Type':
        input.mime === 'audio/wav'
          ? 'audio/wav; codecs=audio/pcm; samplerate=16000'
          : 'audio/ogg; codecs=opus',
    },
    body: new Uint8Array(input.bytes),
  })
  if (data.RecognitionStatus !== 'Success')
    throw new Error('Azure 没有识别到有效语音，请检查格式、语言和时长')
  const text = data.NBest?.[0]?.Display || data.DisplayText,
    offset = Number(data.Offset || 0) / 10000000,
    duration = Number(data.Duration || 0) / 10000000
  if (typeof text !== 'string' || !duration) throw new Error('Azure 未返回文字和时码')
  return {
    summary: '语音识别完成',
    files: [
      await outputJson(ctx, data, 'transcription.json'),
      await outputBytes(
        ctx,
        Buffer.from(`1\n${timestamp(offset)} --> ${timestamp(offset + duration)}\n${text}\n`),
        'subtitle',
        'srt',
      ),
    ],
    data: { text, segments: [{ start: offset, end: offset + duration, text }] },
  }
}
async function existingAdapter(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  const config = ctx.config!,
    kind = ctx.toolId === 'openai_image' || ctx.toolId === 'seedream_image' ? 'image' : 'video',
    adapter = kind === 'image' ? getImageAdapter(config.provider) : getVideoAdapter(config.provider)
  let result: any = ctx.state.syncResult
  if (!ctx.state.remoteId && !result) {
    const image = str(ctx.args, ['image', 'image_url', 'first_frame', 'first_frame_url']),
      imageUri = image ? await mediaDataUri(ctx, deps, image, 'image') : undefined
    const refs = ctx.args.reference_images
    const references = Array.isArray(refs)
      ? await Promise.all(refs.slice(0, 9).map((v) => mediaDataUri(ctx, deps, String(v), 'image')))
      : imageUri
        ? [imageUri]
        : []
    const record: any = {
      id: 0,
      prompt: required(ctx.args, ['prompt', 'description'], '生成描述'),
      model: config.model,
      size: str(ctx.args, 'size', '1536x1024'),
      referenceImages: JSON.stringify(references),
      firstFrameUrl: imageUri,
      imageUrl: imageUri,
      duration: num(ctx.args, 'duration', 5, 2, 20),
      aspectRatio: str(ctx.args, 'aspect_ratio', '16:9'),
      resolution: str(ctx.args, 'resolution', '720p'),
      generateAudio: ctx.args.generate_audio !== false,
      referenceMode: 'first_last_frame',
    }
    const req = adapter.buildGenerateRequest(config, record)
    ensureCanSubmit(ctx)
    checkpoint(ctx, {
      submissionStarted: true,
      provider: config.provider,
      configId: config.id,
      model: config.model,
    })
    result = await jsonRequest(ctx, deps, req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body instanceof FormData ? req.body : req.body === undefined ? undefined : jsonBody(req.body),
    })
    const parsed = adapter.parseGenerateResponse(result)
    if (parsed.isAsync) {
      if (!parsed.taskId) throw new Error('生成服务未返回任务 ID')
      checkpoint(ctx, { remoteId: parsed.taskId })
    } else checkpoint(ctx, { syncResult: result })
  }
  if (ctx.state.remoteId) {
    result = await poll(
      ctx,
      deps,
      async () => {
        const req = adapter.buildPollRequest(config, String(ctx.state.remoteId))
        return jsonRequest(ctx, deps, req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body === undefined ? undefined : jsonBody(req.body),
        })
      },
      (v) => adapter.parsePollResponse(v).status === 'completed',
      (v) => adapter.parsePollResponse(v).status === 'failed',
    )
  }
  let file
  if (kind === 'image') {
    const a = getImageAdapter(config.provider),
      encoded = a.extractImageBase64(result)
    if (encoded)
      file = await outputBytes(
        ctx,
        Buffer.from(encoded.data, 'base64'),
        'image',
        encoded.mimeType.includes('jpeg') ? 'jpg' : 'png',
      )
    else {
      const url = a.extractImageUrl(result)
      if (!url) throw new Error('图片服务没有返回文件')
      file = await outputRemote(ctx, deps, url, 'image', [
        'openai.com',
        'oaiusercontent.com',
        'blob.core.windows.net',
        'volces.com',
        'byteimg.com',
        'bytepluses.com',
      ])
    }
  } else {
    const url = getVideoAdapter(config.provider).extractVideoUrl(result)
    if (!url) throw new Error('视频服务没有返回文件')
    file = await outputRemote(
      ctx,
      deps,
      url,
      'video',
      [
        'minimax.io',
        'minimax.chat',
        'minimaxi.com',
        'volces.com',
        'byteimg.com',
        'bytepluses.com',
        'aliyuncs.com',
      ],
      'mp4',
    )
  }
  ctx.progress(100)
  return {
    summary: '生成完成，媒体已保存到项目',
    files: [file],
    data: { remoteId: ctx.state.remoteId, model: config.model },
  }
}
export async function runDirect(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  if (Object.hasOwn(regionalToolSpecs, ctx.toolId)) return runRegional(ctx, deps)
  if (Object.hasOwn(klingToolSpecs, ctx.toolId)) return runKling(ctx, deps)
  if (Object.hasOwn(extraToolSpecs, ctx.toolId)) return runExtra(ctx, deps)
  if (ctx.toolId === 'music_gen') return music(ctx, deps)
  if (ctx.toolId === 'azure_stt') return azureStt(ctx, deps)
  if (ctx.toolId.endsWith('_tts')) return speech(ctx, deps)
  if (
    [
      'openai_image',
      'seedream_image',
      'minimax_video',
      'seedance_ark',
      'seedance_video',
      'jimeng_video',
    ].includes(ctx.toolId)
  )
    return existingAdapter(ctx, deps)
  return runMediaProvider(ctx, deps)
}
