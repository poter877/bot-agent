/** Kling's documented v1 job contract; AK:SK stays in the shared server-side secret store. */
import { createHmac } from 'node:crypto'
import {
  checkpoint,
  ensureCanSubmit,
  jsonBody,
  jsonRequest,
  num,
  outputRemote,
  poll,
  required,
  serviceUrl,
  str,
  type ProviderContext,
  type ProviderDependencies,
  type ProviderResult,
} from './provider-runtime.js'
export const klingToolSpecs = {
  kling_official_image: {
    serviceType: 'image',
    provider: 'kling_official',
    model: 'kling-v2',
  },
  kling_official_video: {
    serviceType: 'video',
    provider: 'kling_official',
    model: 'kling-v2-6',
  },
  kling_video: {
    serviceType: 'video',
    provider: 'kling_official',
    model: 'kling-v2-6',
  },
} as const
export function klingToken(value: string, time = Date.now()) {
  const split = value.indexOf(':')
  if (split < 1 || split === value.length - 1)
    throw new Error('请在可灵密钥中填写 AccessKey:SecretKey（只保存在服务端）')
  const access = value.slice(0, split),
    secret = value.slice(split + 1),
    seconds = Math.floor(time / 1000)
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url'),
    body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: access, exp: seconds + 1800, nbf: seconds - 5 })}`
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}
export async function runKling(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  const c = ctx.config!,
    imageTool = ctx.toolId === 'kling_official_image',
    base = serviceUrl(c, '', '/v1'),
    headers = () => ({
      Authorization: `Bearer ${klingToken(c.apiKey)}`,
      'Content-Type': 'application/json',
    })
  let endpoint = String(
    ctx.state.endpoint ||
      (imageTool
        ? 'images/generations'
        : str(ctx.args, ['image', 'image_url', 'first_frame'])
          ? 'videos/image2video'
          : 'videos/text2video'),
  )
  if (!['images/generations', 'videos/image2video', 'videos/text2video'].includes(endpoint))
    throw new Error('保存的可灵查询路径无效')
  if (!ctx.state.remoteId) {
    const body: Record<string, unknown> = {
      model_name: c.model,
      prompt: required(ctx.args, ['prompt', 'description'], '生成描述'),
    }
    if (String(body.prompt).length > 2500) throw new Error('可灵描述最多 2500 字，请缩短后重试')
    const image = str(ctx.args, ['image', 'image_url', 'first_frame'])
    if (image) {
      const f = await deps.readMedia(ctx, image, 'image')
      if (f.bytes.length > 10 * 1024 * 1024) throw new Error('可灵输入图片须小于 10 MB')
      body.image = f.bytes.toString('base64')
    }
    if (imageTool) {
      body.n = Math.round(num(ctx.args, ['count', 'num_images'], 1, 1, 4))
      body.aspect_ratio = str(ctx.args, 'aspect_ratio', '16:9')
    } else {
      const duration = num(ctx.args, 'duration', 5, 5, 10)
      if (duration !== 5 && duration !== 10) throw new Error('此可灵模型的时长请选择 5 秒或 10 秒')
      body.duration = String(duration)
      body.mode = str(ctx.args, 'mode', 'pro')
      if (!image) body.aspect_ratio = str(ctx.args, 'aspect_ratio', '16:9')
      if (c.model === 'kling-v2-6') body.sound = ctx.args.generate_audio === false ? 'off' : 'on'
    }
    // Generate and validate the authorization token before marking a billable submission.
    const auth = headers()
    ensureCanSubmit(ctx)
    checkpoint(ctx, {
      endpoint,
      submissionStarted: true,
      provider: c.provider,
      configId: c.id,
      model: c.model,
    })
    const data = await jsonRequest(ctx, deps, `${base}/${endpoint}`, {
      method: 'POST',
      headers: auth,
      body: jsonBody(body),
    })
    if (data.code !== undefined && data.code !== 0) {
      checkpoint(ctx, { rejected: true })
      throw new Error('服务拒绝了可灵请求，请检查账号权限、额度和参数')
    }
    if (typeof data.data?.task_id !== 'string')
      throw new Error('服务未返回可灵任务 ID，请核对控制台后恢复查询')
    checkpoint(ctx, { remoteId: data.data.task_id })
  }
  const data = await poll(
    ctx,
    deps,
    async () => {
      const response = await jsonRequest(
        ctx,
        deps,
        `${base}/${endpoint}/${encodeURIComponent(String(ctx.state.remoteId))}`,
        { headers: headers() },
      )
      if (response.code !== undefined && response.code !== 0)
        throw new Error('服务拒绝可灵任务查询，请检查原账户配置')
      return response.data
    },
    (v) => v.task_status === 'succeed',
    (v) => v.task_status === 'failed',
  )
  const list = imageTool ? data.task_result?.images : data.task_result?.videos
  if (!Array.isArray(list) || !list.length) throw new Error('服务未返回可灵生成文件')
  const files: ProviderResult['files'] = []
  for (const item of list.slice(0, 4))
    if (typeof item.url === 'string')
      files.push(
        await outputRemote(
          ctx,
          deps,
          item.url,
          imageTool ? 'image' : 'video',
          [
            'klingai.com',
            'kling.ai',
            'klingai.net',
            'klingai.cn',
            'kwai.com',
            'kwaicdn.com',
            'kuaishouzt.com',
            'ksapisrv.com',
          ],
          imageTool ? undefined : 'mp4',
        ),
      )
  if (!files.length) throw new Error('服务未返回可用的可灵产物')
  ctx.progress(100)
  return {
    summary: '可灵媒体生成完成',
    files,
    data: { remoteId: ctx.state.remoteId, model: c.model },
  }
}
