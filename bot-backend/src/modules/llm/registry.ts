import { readFileSync } from 'node:fs'

/**
 * models.dev 注册表快照（AI SDK 生态的开放 provider/模型数据库，刷新方式见
 * bot-backend/AGENTS.md）：每个条目带官方 @ai-sdk 适配器包名（npm）、默认端点
 * （api；openai/anthropic 等原生适配器用内置默认端点故缺省）、厂商密钥环境
 * 变量名（env）与模型清单。控制台下拉与网关的适配器选择都以此为准。
 */

export interface RegistryModel {
  name: string
  reasoning: boolean
  tool_call: boolean
  modalities: { input: string[]; output: string[] }
}

export type RegistryModelKind = 'text' | 'image' | 'video' | 'speech' | 'transcription'

/** 按模态分类：输出 text→文本，output image/video→图片/视频，
 *  output audio→语音合成，输入 audio 且非纯输出→转写。 */
export function registryModelKinds(model: RegistryModel): RegistryModelKind[] {
  const kinds: RegistryModelKind[] = []
  const output = new Set(model.modalities?.output ?? ['text'])
  const input = new Set(model.modalities?.input ?? [])
  if (output.has('text')) kinds.push('text')
  if (output.has('image')) kinds.push('image')
  if (output.has('video')) kinds.push('video')
  if (output.has('audio')) kinds.push('speech')
  if (input.has('audio') && !output.has('audio')) kinds.push('transcription')
  return kinds.length ? kinds : ['text']
}

export interface RegistryProvider {
  id: string
  name: string
  /** 默认端点；原生适配器（openai/anthropic）缺省表示使用 SDK 内置端点。 */
  api?: string
  /** 官方 @ai-sdk/* 适配器包名。 */
  npm: string
  /** 厂商密钥的环境变量名（首个为主键名）。 */
  env: string[]
  models: Record<string, RegistryModel>
}

type Registry = Record<string, RegistryProvider>

const REGISTRY: Registry = JSON.parse(readFileSync(new URL('./models-registry.json', import.meta.url), 'utf8'))

export function registryProvider(id: string): RegistryProvider | undefined {
  return REGISTRY[id.trim().toLowerCase()]
}

export function registryList(): RegistryProvider[] {
  return Object.values(REGISTRY).sort((a, b) => a.name.localeCompare(b.name))
}

/** 厂商密钥的环境变量名列表；未收录的 provider 返回空数组。 */
export function registryEnvKeys(id: string): string[] {
  return registryProvider(id)?.env ?? []
}

const NATIVE_DEFAULT_ENDPOINT = new Set(['@ai-sdk/openai', '@ai-sdk/anthropic', '@ai-sdk/google'])

/** 未收录 provider、或收录但既无默认端点又非原生适配器时，必须显式填写 baseURL。 */
export function registryNeedsBaseURL(id: string): boolean {
  const meta = registryProvider(id)
  if (!meta) return true
  return !NATIVE_DEFAULT_ENDPOINT.has(meta.npm) && !meta.api
}
