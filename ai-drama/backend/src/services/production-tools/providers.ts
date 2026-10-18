/** Independently implemented production provider adapters; no reference runtime is loaded. */
import { companyBackendUrl } from '../company-backend.js'
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
  atlascloud: { label: 'Atlas Cloud', baseUrl: 'https://api.atlascloud.ai' },
  higgsfield: { label: 'Higgsfield', baseUrl: 'https://api.higgsfield.ai' },
  dashscope: { label: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com' },
  google: {
    label: 'Google Cloud Vertex',
    baseUrl: 'https://us-central1-aiplatform.googleapis.com',
  },
  replicate: { label: 'Replicate', baseUrl: 'https://api.replicate.com' },
  comfyui: { label: 'ComfyUI', baseUrl: 'http://127.0.0.1:8188' },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
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
/** fal 不再是独立服务商：它只是公司后端队列端点背后的一种模型来源，
 *  连接数据与 provider='company' 同源（{COMPANY} 根地址，路径由 runFal 拼）。
 *  厂商密钥在公司侧，本侧只带内部服务令牌。未配置公司后端时不暴露预设
 * （工具显式不可用），避免落到必然失败的直连地址。 */
function providerBase(provider: string): { label: string; baseUrl: string } | undefined {
  if (provider === 'fal')
    return companyBackendUrl() ? { label: 'Fal', baseUrl: companyBackendUrl() } : undefined
  return providerBases[provider]
}

export interface ProviderPreset {
  label: string
  baseUrl: string
  models: string[]
  requiresApiKey?: boolean
}
let presetsCache: Record<string, Record<string, ProviderPreset>> | null = null
/** 预设含 env 派生的公司代理地址；providers 链先于 dotenv 求值，只能构建于首次访问。 */
export function providerPresets() {
  if (!presetsCache) {
    presetsCache = {}
    for (const spec of Object.values(providerToolSpecs)) {
      const base = providerBase(spec.provider)
      if (!base) continue
      const group = presetsCache[spec.serviceType] ?? (presetsCache[spec.serviceType] = {})
      const preset =
        group[spec.provider] ??
        (group[spec.provider] = {
          ...base,
          models: [],
          requiresApiKey: spec.requiresApiKey !== false,
        })
      if (!preset.models.includes(spec.model)) preset.models.push(spec.model)
    }
  }
  return presetsCache
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
