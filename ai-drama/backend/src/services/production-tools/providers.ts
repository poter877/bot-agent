/** Independently implemented production provider adapters; no reference runtime is loaded. */
import {
  falToolModels,
  replicateToolModels,
  comfyToolKinds,
  runFal,
  runReplicate,
  runComfy,
} from './provider-queue.js'
import { runDirect, directToolSpecs } from './provider-direct.js'
import { runStock, stockToolSpecs } from './provider-stock.js'
import {
  providerDependencies,
  type ProviderContext,
  type ProviderDependencies,
  type ProviderResult,
} from './provider-runtime.js'
export type { ProviderContext, ProviderDependencies, ProviderResult } from './provider-runtime.js'
export interface ProviderToolSpec {
  serviceType: string
  provider: string
  model: string
  requiresApiKey?: boolean
}
export const providerToolSpecs: Record<string, ProviderToolSpec> = {
  ...Object.fromEntries(
    Object.entries(falToolModels).map(([id, s]) => [
      id,
      {
        serviceType:
          s.kind === 'audio'
            ? id.includes('tts')
              ? 'speech'
              : 'music'
            : s.kind === 'model'
              ? 'model3d'
              : s.kind,
        provider: 'fal',
        model: s.model,
      },
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(replicateToolModels).map(([id, s]) => [
      id,
      { serviceType: s.kind, provider: 'replicate', model: s.model },
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(comfyToolKinds).map(([id, kind]) => [
      id,
      {
        serviceType: kind === 'audio' ? 'music' : kind,
        provider: 'comfyui',
        model: 'api-workflow',
        requiresApiKey: false,
      },
    ]),
  ),
  ...directToolSpecs,
  ...stockToolSpecs,
}
const providerBases: Record<string, { label: string; baseUrl: string }> = {
  doubao: { label: '豆包语音', baseUrl: 'https://openspeech.bytedance.com' },
  hunyuan_cloud: {
    label: '腾讯云混元',
    baseUrl: 'https://hunyuan.tencentcloudapi.com',
  },
  kling_official: {
    label: '可灵官方',
    baseUrl: 'https://api-beijing.klingai.com',
  },
  atlascloud: { label: 'Atlas Cloud', baseUrl: 'https://api.atlascloud.ai' },
  higgsfield: { label: 'Higgsfield', baseUrl: 'https://api.higgsfield.ai' },
  dashscope: { label: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com' },
  google: {
    label: 'Google Cloud Vertex',
    baseUrl: 'https://us-central1-aiplatform.googleapis.com',
  },
  fal: { label: 'Fal', baseUrl: 'https://queue.fal.run' },
  replicate: { label: 'Replicate', baseUrl: 'https://api.replicate.com' },
  comfyui: { label: 'ComfyUI', baseUrl: 'http://127.0.0.1:8188' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com' },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
  },
  volcengine: {
    label: '火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com',
  },
  minimax: { label: 'MiniMax', baseUrl: 'https://api.minimax.io' },
  aliyun: { label: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com' },
  elevenlabs: { label: 'ElevenLabs', baseUrl: 'https://api.elevenlabs.io' },
  cartesia: { label: 'Cartesia', baseUrl: 'https://api.cartesia.ai' },
  fish_audio: { label: 'Fish Audio', baseUrl: 'https://api.fish.audio' },
  inworld: { label: 'Inworld', baseUrl: 'https://api.inworld.ai' },
  google_tts: {
    label: 'Google Cloud TTS',
    baseUrl: 'https://texttospeech.googleapis.com',
  },
  azure: {
    label: 'Azure Speech',
    baseUrl: 'https://eastus.tts.speech.microsoft.com',
  },
  grok: { label: 'xAI Grok', baseUrl: 'https://api.x.ai' },
  ideogram: { label: 'Ideogram', baseUrl: 'https://api.ideogram.ai' },
  recraft: { label: 'Recraft', baseUrl: 'https://external.api.recraft.ai' },
  runway: { label: 'Runway', baseUrl: 'https://api.dev.runwayml.com' },
  ltx: { label: 'LTX', baseUrl: 'https://api.ltx.io' },
  heygen: { label: 'HeyGen', baseUrl: 'https://api.heygen.com' },
  pexels: { label: 'Pexels', baseUrl: 'https://api.pexels.com' },
  pixabay: { label: 'Pixabay', baseUrl: 'https://pixabay.com' },
  freesound: { label: 'Freesound', baseUrl: 'https://freesound.org' },
  unsplash: { label: 'Unsplash', baseUrl: 'https://api.unsplash.com' },
  nasa: { label: 'NASA Images', baseUrl: 'https://images-api.nasa.gov' },
  wikimedia: {
    label: 'Wikimedia Commons',
    baseUrl: 'https://commons.wikimedia.org',
  },
  archive_org: { label: 'Internet Archive', baseUrl: 'https://archive.org' },
  loc: { label: 'Library of Congress', baseUrl: 'https://www.loc.gov' },
}
export const providerPresets: Record<
  string,
  Record<
    string,
    {
      label: string
      baseUrl: string
      models: string[]
      requiresApiKey?: boolean
    }
  >
> = {}
for (const spec of Object.values(providerToolSpecs)) {
  const base = providerBases[spec.provider]
  if (!base) continue
  const group = providerPresets[spec.serviceType] ?? (providerPresets[spec.serviceType] = {})
  const preset =
    group[spec.provider] ??
    (group[spec.provider] = {
      ...base,
      models: [],
      requiresApiKey: spec.requiresApiKey !== false,
    })
  if (!preset.models.includes(spec.model)) preset.models.push(spec.model)
}
export const supportedProviderToolIds = Object.keys(providerToolSpecs)
export async function runProviderTool(
  ctx: ProviderContext,
  overrides: Partial<ProviderDependencies> = {},
): Promise<ProviderResult> {
  const spec = providerToolSpecs[ctx.toolId]
  if (!spec) throw new Error('此工具尚无经过验证的服务商适配器，请选择工具目录中可用的服务')
  if (!ctx.config)
    throw new Error(`请先在「模型与服务」中配置并启用 ${spec.provider} 的 ${spec.serviceType} 服务`)
  if (ctx.config.provider !== spec.provider)
    throw new Error(`此工具需要 ${spec.provider} 配置，不能使用 ${ctx.config.provider}`)
  if (spec.requiresApiKey !== false && !ctx.config.apiKey)
    throw new Error(`请在「模型与服务」中填写 ${spec.provider} 密钥`)
  if (ctx.state.provider && ctx.state.provider !== ctx.config.provider)
    throw new Error('恢复任务必须使用原服务商配置')
  if (ctx.state.configId && ctx.config.id !== ctx.state.configId)
    throw new Error('恢复任务必须使用原模型配置，避免查询其他账户')
  const deps = { ...providerDependencies, ...overrides }
  if (falToolModels[ctx.toolId]) return runFal(ctx, deps)
  if (replicateToolModels[ctx.toolId]) return runReplicate(ctx, deps)
  if (comfyToolKinds[ctx.toolId]) return runComfy(ctx, deps)
  if (Object.hasOwn(stockToolSpecs, ctx.toolId)) return runStock(ctx, deps)
  return runDirect(ctx, deps)
}
