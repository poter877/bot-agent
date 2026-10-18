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
const falDomains = ['fal.media', 'fal.run', 'storage.googleapis.com']
function modelId(model: string) {
  if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_./-]+$/.test(model) || model.includes('..') || model.includes('//'))
    throw new Error('模型 ID 无效，请选择服务预设')
  return model
}
function queueUrl(config: NonNullable<ProviderContext['config']>, model: string) {
  const base = serviceUrl(config, '')
  const u = new URL(base)
  if (u.hostname !== 'queue.fal.run') throw new Error('Fal 队列服务地址须使用 https://queue.fal.run')
  return `${base}/${modelId(model)}`
}
function falResultFiles(data: any, kind: OutputKind) {
  if (kind === 'image')
    return (Array.isArray(data.images) ? data.images : [data.image])
      .filter(Boolean)
      .map((v: any) => (typeof v === 'string' ? v : v.url))
  if (kind === 'video') return [data.video?.url || data.video_url].filter(Boolean)
  if (kind === 'audio') return [data.audio?.url || data.audio_url || data.music?.url].filter(Boolean)
  return [
    data.model_glb?.url ||
      data.model_mesh?.url ||
      data.model?.url ||
      data.glb?.url ||
      data.model_glb ||
      data.model_mesh,
  ].filter((v) => typeof v === 'string')
}
export async function runFal(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  const spec = falToolModels[ctx.toolId]
  if (!spec) throw new Error('没有对应的 Fal 工具')
  const config = ctx.config!,
    model = typeof ctx.state.queueModel === 'string' ? ctx.state.queueModel : spec.model,
    url = queueUrl(config, model),
    headers = {
      Authorization: `Key ${config.apiKey}`,
      'Content-Type': 'application/json',
    }
  if (!ctx.state.remoteId) {
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
    const submitted = await submitJson(ctx, deps, url, input, headers, (v) => v.request_id)
    // Fal may remove endpoint subpaths in returned queue URLs. Persist the authoritative URLs.
    const safe = (value: unknown) => {
      if (typeof value !== 'string') return undefined
      const next = new URL(value)
      if (next.origin !== new URL(url).origin || !next.pathname.startsWith('/'))
        throw new Error('Fal 返回了不受信任的查询地址')
      return next.href
    }
    checkpoint(ctx, {
      statusUrl: safe(submitted.status_url),
      responseUrl: safe(submitted.response_url),
      queueModel: model,
    })
  }
  const id = encodeURIComponent(String(ctx.state.remoteId)),
    statusUrl =
      typeof ctx.state.statusUrl === 'string' ? ctx.state.statusUrl : `${url}/requests/${id}/status`,
    resultUrl = typeof ctx.state.responseUrl === 'string' ? ctx.state.responseUrl : `${url}/requests/${id}`
  const safeStored = (value: string) => {
    if (new URL(value).origin !== new URL(url).origin) throw new Error('保存的服务查询地址无效')
    return value
  }
  const status = await poll(
    ctx,
    deps,
    () => jsonRequest(ctx, deps, safeStored(statusUrl), { headers }),
    (v) => v.status === 'COMPLETED',
    (v) => v.status === 'FAILED' || v.status === 'ERROR' || !!v.error,
  )
  if (status.error) throw new Error('Fal 任务失败，请查看服务控制台')
  const data = await jsonRequest(ctx, deps, safeStored(resultUrl), { headers }),
    urls = falResultFiles(data, spec.kind)
  if (!urls.length || urls.some((u: unknown) => typeof u !== 'string'))
    throw new Error('Fal 任务未返回可用的输出文件')
  const files = []
  for (const remote of urls.slice(0, 4))
    files.push(
      await outputRemote(ctx, deps, remote, spec.kind, falDomains, spec.kind === 'model' ? 'glb' : undefined),
    )
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
