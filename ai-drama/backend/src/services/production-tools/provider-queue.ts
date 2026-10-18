import { randomUUID } from 'node:crypto'
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
/** 工具预设里的模型 id 只是默认回落：模型服务配置行的 model 优先
 *  （executor 已把它解析为 args.model ?? spec.model，工具间不会串模型），
 *  恢复任务时 ctx.state.queueModel 钉住原提交的模型。队列调用统一走公司后端
 *  的 {COMPANY}/api/media/queue：submit→poll→download 在公司侧内化，服务端
 *  持厂商密钥，同步返回 {ok, request_id, assets:[{media_type, base64}]}——
 *  fal 只是该端点背后的一种模型来源，本侧没有"fal 直连/代理"的概念。 */
export const falToolModels: Record<string, { model: string; kind: OutputKind }> = {
  flux_image: { model: 'fal-ai/flux/schnell', kind: 'image' },
  gemini_fal_image: { model: 'fal-ai/nano-banana', kind: 'image' },
  openai_fal_image: {
    model: 'fal-ai/gpt-image-1/text-to-image',
    kind: 'image',
  },
  ideogram_fal_image: { model: 'fal-ai/ideogram/v3', kind: 'image' },
  fal_elevenlabs_tts: {
    model: 'fal-ai/elevenlabs/tts/multilingual-v2',
    kind: 'audio',
  },
  fal_elevenlabs_music: { model: 'fal-ai/elevenlabs/music', kind: 'audio' },
  fal_3d: { model: 'fal-ai/hunyuan3d/v2/turbo', kind: 'model' },
  wan_fal_video: { model: 'fal-ai/wan/v2.2-a14b/text-to-video', kind: 'video' },
  minimax_fal_video: {
    model: 'fal-ai/minimax/hailuo-02/standard/text-to-video',
    kind: 'video',
  },
  gemini_omni_fal: { model: 'google/gemini-omni-flash', kind: 'video' },
  h3_max_video: {
    model: 'fal-ai/minimax/h3-max/image-to-video',
    kind: 'video',
  },
}
function modelId(model: string) {
  if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_./-]+$/.test(model) || model.includes('..') || model.includes('//'))
    throw new Error('模型 ID 无效，请选择服务预设')
  return model
}
/** 公司队列端点的同步等待要覆盖服务端的媒体预算（默认 600s），超时留给
 *  服务端先给出明确的 502，而不是客户端先掐断传输。 */
const QUEUE_CALL_TIMEOUT_MS = 720000
/** 队列响应是 base64 JSON：给足多文件大资产的余量（服务端单资产上限 200MB）。 */
const QUEUE_RESPONSE_MAX_BYTES = 1024 * 1024 * 1024
const ASSET_EXTENSIONS: Record<string, string> = {
  png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif', avif: 'avif',
  mpeg: 'mp3', mp3: 'mp3', wav: 'wav', 'x-wav': 'wav', wave: 'wav', ogg: 'ogg', flac: 'flac', m4a: 'm4a',
  mp4: 'mp4', webm: 'webm',
}
const KIND_EXTENSIONS: Record<OutputKind, string> = {
  image: 'png', video: 'mp4', audio: 'mp3', subtitle: 'srt', model: 'glb', archive: 'zip', data: 'json',
}
function assetExtension(mediaType: unknown, kind: OutputKind) {
  if (kind === 'model') return 'glb'
  const subtype = typeof mediaType === 'string' && mediaType.includes('/')
    ? mediaType.slice(mediaType.indexOf('/') + 1).split(';')[0]!.toLowerCase()
    : ''
  return ASSET_EXTENSIONS[subtype] ?? KIND_EXTENSIONS[kind]
}
function assetBytes(asset: unknown): Buffer {
  const base64 = (asset as any)?.base64
  if (
    typeof base64 !== 'string' ||
    !base64.length ||
    base64.length > 300 * 1024 * 1024 ||
    !/^[A-Za-z0-9+/=\r\n]+$/.test(base64)
  )
    throw new Error('云端队列返回了无效的媒体资产')
  return Buffer.from(base64, 'base64')
}
export async function runFal(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  const spec = falToolModels[ctx.toolId]
  if (!spec) throw new Error('没有对应的 Fal 工具')
  const config = ctx.config!,
    configured = typeof ctx.state.queueModel === 'string' && ctx.state.queueModel.trim() !== ''
      ? ctx.state.queueModel
      : typeof config.model === 'string' && config.model.trim() !== ''
        ? config.model
        : spec.model,
    model = modelId(configured)
  const input: Record<string, unknown> = {}
  const p = str(ctx.args, ['prompt', 'description', 'text'])
  if (!p && spec.kind !== 'model') throw new Error('请填写生成描述或朗读文本')
  if (ctx.toolId === 'fal_elevenlabs_tts') {
    input.text = p
    input.voice = str(ctx.args, ['voice', 'voice_id'], 'Rachel')
    input.speed = num(ctx.args, 'speed', 1, 0.7, 1.2)
  } else if (ctx.toolId === 'fal_elevenlabs_music') {
    input.prompt = p
    input.music_length_ms = Math.round(num(ctx.args, ['duration', 'duration_seconds'], 30, 3, 600) * 1000)
    input.force_instrumental = ctx.args.instrumental !== false
  } else if (spec.kind === 'model') {
    input.input_image_url = await mediaDataUri(
      ctx,
      deps,
      required(ctx.args, ['image', 'image_url', 'input_image'], '三维模型参考图片'),
      'image',
    )
  } else {
    input.prompt = p
    if (spec.kind === 'image') {
      input.num_images = Math.round(num(ctx.args, ['num_images', 'count'], 1, 1, 4))
      if (ctx.toolId === 'flux_image') input.image_size = str(ctx.args, 'image_size', 'landscape_16_9')
      else input.aspect_ratio = str(ctx.args, 'aspect_ratio', '16:9')
    }
    if (spec.kind === 'video' && ctx.toolId === 'gemini_omni_fal') {
      input.aspect_ratio = str(ctx.args, 'aspect_ratio', '16:9')
      input.duration = Math.round(num(ctx.args, 'duration', 8, 3, 10))
    }
    if (ctx.toolId === 'h3_max_video')
      input.image_url = await mediaDataUri(
        ctx,
        deps,
        required(ctx.args, ['image', 'image_url', 'input_image'], '首帧参考图片'),
        'image',
      )
    if (ctx.toolId === 'minimax_fal_video') input.duration = String(num(ctx.args, 'duration', 6, 6, 10))
  }
  if (ctx.args.seed !== undefined) input.seed = num(ctx.args, 'seed', 0, 0, 4294967295)
  ensureCanSubmit(ctx)
  checkpoint(ctx, {
    submissionStarted: true,
    provider: ctx.config?.provider,
    configId: ctx.config?.id,
    model,
    queueModel: model,
  })
  let data: any
  try {
    data = await jsonRequest(
      ctx,
      deps,
      serviceUrl(config, '/api/media/queue'),
      {
        method: 'POST',
        headers: bearer(config.apiKey),
        body: jsonBody({ model, input }),
        timeoutMs: QUEUE_CALL_TIMEOUT_MS,
      },
      QUEUE_RESPONSE_MAX_BYTES,
    )
  } catch (error) {
    // 队列端点是同步事务：请求失败即结果不可恢复（资产不会回投），重试按新任务提交
    checkpoint(ctx, { submissionStarted: false })
    throw error
  }
  const assets = Array.isArray(data.assets) ? data.assets : []
  if (!assets.length) throw new Error('云端生成未返回可用的输出文件')
  const files = []
  for (const asset of assets.slice(0, 4))
    files.push(await outputBytes(ctx, assetBytes(asset), spec.kind, assetExtension(asset?.media_type, spec.kind)))
  checkpoint(ctx, {
    submissionStarted: false,
    ...(typeof data.request_id === 'string' && data.request_id ? { remoteId: data.request_id } : {}),
  })
  ctx.progress(100)
  return {
    summary: '云端生成完成，文件已保存到项目',
    files,
    data: { remoteId: ctx.state.remoteId, model, seed: data.seed },
  }
}
export const replicateToolModels: Record<string, { model: string; kind: OutputKind }> = {
  gemini_replicate_image: { model: 'google/nano-banana', kind: 'image' },
  wan_replicate_video: { model: 'wan-video/wan-2.2-t2v-fast', kind: 'video' },
  seedance_replicate: { model: 'bytedance/seedance-1-pro', kind: 'video' },
}
export async function runReplicate(
  ctx: ProviderContext,
  deps: ProviderDependencies,
): Promise<ProviderResult> {
  const spec = replicateToolModels[ctx.toolId],
    config = ctx.config!,
    model = modelId(spec.model),
    headers = bearer(config.apiKey),
    base = serviceUrl(config, '', '/v1')
  if (!ctx.state.remoteId) {
    const input: Record<string, unknown> = {
      prompt: required(ctx.args, ['prompt', 'description'], '生成描述'),
    }
    if (ctx.toolId === 'gemini_replicate_image') {
      input.output_format = 'png'
      const image = str(ctx.args, ['image', 'image_url'])
      if (image) input.image_input = [await mediaDataUri(ctx, deps, image, 'image')]
    }
    if (ctx.toolId === 'seedance_replicate') {
      input.duration = num(ctx.args, 'duration', 5, 5, 10)
      input.aspect_ratio = str(ctx.args, 'aspect_ratio', '16:9')
      input.resolution = str(ctx.args, 'resolution', '1080p')
      const image = str(ctx.args, ['image', 'image_url', 'first_frame'])
      if (image) input.image = await mediaDataUri(ctx, deps, image, 'image')
    }
    await submitJson(ctx, deps, `${base}/models/${model}/predictions`, { input }, headers, (v) => v.id)
  }
  const data = await poll(
    ctx,
    deps,
    () =>
      jsonRequest(ctx, deps, `${base}/predictions/${encodeURIComponent(String(ctx.state.remoteId))}`, {
        headers,
      }),
    (v) => v.status === 'succeeded',
    (v) => ['failed', 'canceled'].includes(v.status),
  )
  const output = Array.isArray(data.output) ? data.output : [data.output]
  const urls = output.flatMap((v: any) => (typeof v === 'string' ? [v] : v?.url ? [v.url] : []))
  if (!urls.length) throw new Error('Replicate 任务没有返回媒体文件')
  const files = []
  for (const url of urls.slice(0, 4))
    files.push(await outputRemote(ctx, deps, url, spec.kind, ['replicate.delivery', 'replicate.com']))
  ctx.progress(100)
  return {
    summary: 'Replicate 生成完成',
    files,
    data: { remoteId: ctx.state.remoteId, model },
  }
}
const comfyKinds: Record<string, OutputKind> = {
  comfyui_image: 'image',
  comfyui_video: 'video',
  comfyui_music: 'audio',
  local_diffusion: 'image',
  qwen_image_21: 'image',
  wan_video: 'video',
  hunyuan_video: 'video',
  cogvideo_video: 'video',
  ltx_video_local: 'video',
}
export const comfyToolKinds = comfyKinds
function parseWorkflow(
  raw: unknown,
): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      throw new Error('ComfyUI 工作流 JSON 无效')
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('请提供从 ComfyUI 导出的 API 格式工作流 workflow_json')
  const nodes = Object.entries(value)
  if (!nodes.length || nodes.length > 300) throw new Error('工作流须包含 1 到 300 个节点')
  for (const [id, node] of nodes) {
    if (
      !/^\d+$/.test(id) ||
      !node ||
      typeof node !== 'object' ||
      typeof (node as any).class_type !== 'string' ||
      !(node as any).inputs ||
      typeof (node as any).inputs !== 'object'
    )
      throw new Error('请使用 ComfyUI API 格式工作流，而不是界面格式 JSON')
  }
  return value as Record<string, { class_type: string; inputs: Record<string, unknown> }>
}
export async function runComfy(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  const config = ctx.config!,
    base = serviceUrl(config, ''),
    headers: Record<string, string> = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    kind = comfyKinds[ctx.toolId]
  if (!ctx.state.remoteId) {
    ensureCanSubmit(ctx)
    const workflow = parseWorkflow(ctx.args.workflow_json ?? ctx.args.workflow)
    const info = await jsonRequest(ctx, deps, `${base}/object_info`, {
      headers,
    })
    for (const node of Object.values(workflow))
      if (!info[node.class_type])
        throw new Error(`ComfyUI 缺少 ${node.class_type} 节点，请在该服务中安装后重试`)
    const promptNode = str(ctx.args, ['prompt_node', 'promptNode'])
    if (promptNode) {
      if (!workflow[promptNode]) throw new Error('提示词节点 ID 不存在')
      workflow[promptNode].inputs[str(ctx.args, 'prompt_input', 'text')] = required(
        ctx.args,
        ['prompt', 'text'],
        '生成描述',
      )
    }
    for (const [name, inputName, mimeKind] of [
      ['image', 'image_node', 'image'],
      ['audio', 'audio_node', 'audio'],
      ['video', 'video_node', 'video'],
    ] as const) {
      const local = str(ctx.args, [name, `${name}_url`]),
        nodeId = str(ctx.args, inputName)
      if (!local) continue
      if (!nodeId || !workflow[nodeId]) throw new Error(`请指定工作流的 ${inputName} 以接入本地素材`)
      const file = await deps.readMedia(ctx, local, mimeKind),
        form = new FormData()
      form.set(
        'image',
        new Blob([new Uint8Array(file.bytes)], { type: file.mime }),
        `${randomUUID()}-${file.name}`,
      )
      form.set('type', 'input')
      form.set('overwrite', 'false')
      const upload = await jsonRequest(ctx, deps, `${base}/upload/image`, {
        method: 'POST',
        headers,
        body: form,
      })
      if (typeof upload.name !== 'string') throw new Error('ComfyUI 上传未返回文件名')
      workflow[nodeId].inputs[str(ctx.args, `${name}_input`, name)] = upload.subfolder
        ? `${upload.subfolder}/${upload.name}`
        : upload.name
    }
    await submitJson(
      ctx,
      deps,
      `${base}/prompt`,
      { prompt: workflow, client_id: randomUUID() },
      { ...headers, 'Content-Type': 'application/json' },
      (v) => v.prompt_id,
    )
  }
  const remoteId = String(ctx.state.remoteId),
    history = await poll(
      ctx,
      deps,
      () => jsonRequest(ctx, deps, `${base}/history/${encodeURIComponent(remoteId)}`, { headers }),
      (v) => !!v[remoteId]?.status?.completed || !!v[remoteId]?.outputs,
      (v) => v[remoteId]?.status?.status_str === 'error',
    )
  const record = history[remoteId]
  if (record?.status?.status_str === 'error') throw new Error('ComfyUI 执行失败，请查看节点错误')
  const files: ProviderResult['files'] = []
  for (const output of Object.values(record?.outputs || {}) as any[]) {
    for (const [key, items] of Object.entries(output)) {
      if (!['images', 'gifs', 'audio', 'videos', 'meshes', '3d'].includes(key) || !Array.isArray(items))
        continue
      for (const item of items.slice(0, 8)) {
        if (
          !item ||
          typeof item.filename !== 'string' ||
          item.filename.includes('..') ||
          /[\\\x00]/.test(item.filename)
        )
          continue
        const params = new URLSearchParams({
          filename: item.filename,
          subfolder: typeof item.subfolder === 'string' ? item.subfolder : '',
          type: item.type === 'temp' ? 'temp' : 'output',
        })
        const extension = item.filename.split('.').pop()?.toLowerCase() || ''
        const actualKind: OutputKind = ['mp4', 'webm', 'gif'].includes(extension)
          ? 'video'
          : ['wav', 'mp3', 'flac', 'ogg'].includes(extension)
            ? 'audio'
            : ['glb', 'gltf', 'obj', 'ply'].includes(extension)
              ? 'model'
              : 'image'
        if (actualKind !== kind) continue
        const response = await request(ctx, deps, `${base}/view?${params}`, { headers }, true)
        files.push(
          await outputBytes(ctx, await responseBytes(response, 512 * 1024 * 1024), actualKind, extension),
        )
      }
    }
  }
  if (!files.length) throw new Error(`ComfyUI 工作流未保存 ${kind} 输出，请接入对应 Save 节点`)
  ctx.progress(100)
  return { summary: 'ComfyUI 工作流执行完成', files, data: { remoteId } }
}
