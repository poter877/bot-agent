/**
 * 单发文本模型调用 — bot-backend 作为模型出口的自用形态。
 *
 * 《重构》后的分工：编排（工具循环）在桌面 Hermes 客户端；bot-backend 只做
 * 单次模型调用。本模块把「服务端业务逻辑需要一次文本生成」的场景统一到
 * 公司后端（COMPANY_BACKEND_URL = bot-backend 自身的 /api/llm），不复活
 * 已退役的 HERMES_AGENT_* 网关。
 *
 * 请求走 /api/llm/stream（AI SDK Core 事件流），这里消费成完整文本返回；
 * text-delta 兼容 ai v4/v5 的字段名。多模态（画面理解）传 content 部件数组。
 */
import { companyBackendUrl, companyConfigured, companyServiceToken } from './company-backend.js'
import { getCompanyModelCatalog } from './company-model-catalog.js'

export type TextModelContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>

export interface TextModelCall {
  system?: string
  prompt: TextModelContent
  /** 缺省用公司文本目录的默认模型 */
  model?: string
  timeoutMs?: number
  correlationId?: string
  /** 调用方取消信号（与内部超时合并） */
  signal?: AbortSignal
}

export class TextModelError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
  }
}

/** 默认文本模型（TTL 缓存的目录解析）。 */
export async function defaultTextModel(): Promise<string> {
  const catalog = await getCompanyModelCatalog('text')
  if (!catalog.defaultModel) throw new TextModelError('公司后端没有可用的文本模型', 503)
  return catalog.defaultModel
}

export async function runTextModel(call: TextModelCall): Promise<string> {
  if (!companyConfigured()) {
    throw new TextModelError('未配置公司后端（COMPANY_BACKEND_URL / COMPANY_SERVICE_TOKEN）', 503)
  }
  const model = call.model || (await defaultTextModel())
  const timeout = AbortSignal.timeout(call.timeoutMs ?? 180_000)
  const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout
  const response = await fetch(`${companyBackendUrl()}/api/llm/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${companyServiceToken()}`,
      ...(call.correlationId ? { 'X-Correlation-Id': call.correlationId } : {}),
    },
    body: JSON.stringify({
      model,
      ...(call.system ? { system: { type: 'text', text: call.system, providerOptions: {} } } : {}),
      messages: [{ role: 'user', content: call.prompt }],
    }),
    signal,
  })
  if (!response.ok || !response.body) {
    throw new TextModelError(`文本模型请求失败（HTTP ${response.status}）`, response.status || 502)
  }

  // 消费 SSE：event: ai-sdk / event: end，帧间以空行分隔
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let endStatus: 'complete' | 'failed' | null = null
  let endError: string | null = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary: number
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const dataLines = frame
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
      if (!dataLines.length) continue
      const eventName = frame.split('\n').find((line) => line.startsWith('event: '))?.slice(7)
      let payload: any
      try {
        payload = JSON.parse(dataLines.join('\n'))
      } catch {
        continue
      }
      if (eventName === 'end') {
        endStatus = payload?.status ?? 'failed'
        endError = payload?.error?.message ?? null
      } else if (eventName === 'ai-sdk' && payload?.type === 'text-delta') {
        text += String(payload.text ?? payload.textDelta ?? payload.delta ?? '')
      } else if (eventName === 'ai-sdk' && payload?.type === 'error') {
        endError = String(payload.error?.message ?? '模型流错误')
      }
    }
  }
  if (endStatus !== 'complete') {
    throw new TextModelError(endError || '文本模型流未正常结束', 502)
  }
  return text
}
