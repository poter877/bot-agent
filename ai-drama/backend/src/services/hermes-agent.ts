/**
 * hermes gateway 编排客户端 — 所有 agent 执行（工具循环 + 模型选择）外移到 hermes。
 *
 * 契约（gateway api_server）：`POST {HERMES_AGENT_URL}/v1/chat/completions`，
 * `Authorization: Bearer <HERMES_AGENT_KEY>`，body 为 OpenAI chat completions 形。
 * 客户端 system 消息被 gateway 采纳（叠加在核心提示之上）；会话由 (system, 首条 user)
 * 内容派生——不同 agent 指令天然隔离会话。工具循环在 hermes 侧经 MCP 跑 ai-drama
 * 领域工具，本客户端只发消息收最终文本（不传 tools）；模型由 hermes drama profile
 * 决定，本侧不再选文本模型。未配置 env 时直接报错，不回落本地编排（公司模式先例）。
 */
import { randomUUID } from 'node:crypto'
import { logTaskProgress } from '../utils/task-logger.js'

export type HermesChatRole = 'system' | 'user' | 'assistant' | 'tool'

/** OpenAI chat completions 内容部件：文本或内联图片（data URL） */
export type HermesContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface HermesChatMessage {
  role: HermesChatRole
  content: string | HermesContentPart[]
}

export interface RunHermesAgentOptions {
  /** agent 指令（作为 system 消息下发，参与会话派生——每个 agent 天然独立会话） */
  instructions: string
  /** 会话消息（不含 system；instructions 会作为首条 system 消息拼入） */
  messages: HermesChatMessage[]
  /** true 走 SSE 流式并返回文本增量迭代器；缺省非流式一次取最终文本 */
  stream?: boolean
  signal?: AbortSignal
  /** 默认 600s——agent 多步工具循环在 hermes 侧跑完才回包，耗时长 */
  timeoutMs?: number
  /** 贯穿链路的关联 id：作为 X-Correlation-Id 头发给 gateway（落 turn 日志并
   *  透传到 bot-backend 模型请求日志），排查任务失败不再对时间戳。调用方有
   *  任务/运行上下文时传任务 id；缺省生成 uuid。 */
  correlationId?: string
}

export interface RunHermesAgentResult {
  text: string
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

/** agent 多步循环默认超时（秒），与前端 agentChat 的 600s 请求超时对齐 */
const DEFAULT_TIMEOUT_MS = 600_000

// env 惰性读取：providers 链在 index.ts 的 `import 'dotenv/config'` 之前求值
// （ESM 按导入序执行），模块级常量会读到 dotenv 之前的空值。
const hermesAgentUrl = () => (process.env.HERMES_AGENT_URL || '').trim().replace(/\/+$/, '')
const hermesAgentKey = () => (process.env.HERMES_AGENT_KEY || '').trim()

const chatCompletionsUrl = () => `${hermesAgentUrl()}/v1/chat/completions`

function requireHermesConfig() {
  if (!hermesAgentUrl() || !hermesAgentKey()) {
    throw new Error('编排已外移到 hermes gateway，需配置 HERMES_AGENT_URL/HERMES_AGENT_KEY')
  }
}

/** 把 fetch 的超时中断翻译成可读错误；调用方主动中止原样上抛 */
async function callGateway(
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  correlationId: string,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    return await fetch(chatCompletionsUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hermesAgentKey()}`,
        'X-Correlation-Id': correlationId,
      },
      body: JSON.stringify(body),
      signal: combined,
    })
  } catch (error) {
    if ((error as DOMException)?.name === 'TimeoutError') {
      throw new Error(`hermes gateway 请求超时（${Math.round(timeoutMs / 1000)}s）`)
    }
    throw error
  }
}

async function errorForStatus(response: Response): Promise<Error> {
  const detail = (await response.text().catch(() => '')).slice(0, 500)
  return new Error(
    `hermes gateway 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`,
  )
}

/** content 兼容字符串与部件数组两种形态（部分网关以 parts 回文本） */
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : ''))
      .join('')
  }
  return ''
}

/** 非流式：一次 POST，取 choices[0].message.content */
async function runHermesAgentOnce(options: RunHermesAgentOptions): Promise<RunHermesAgentResult> {
  const { instructions, messages, signal, timeoutMs = DEFAULT_TIMEOUT_MS, correlationId } = options
  const correlation = correlationId || randomUUID()
  requireHermesConfig()
  logTaskProgress('HermesAgent', 'request', { messages: messages.length, stream: false, correlationId: correlation })
  const response = await callGateway(
    { messages: [{ role: 'system', content: instructions }, ...messages] },
    signal,
    timeoutMs,
    correlation,
  )
  if (!response.ok) throw await errorForStatus(response)
  const payload = await response.json()
  const choice = payload?.choices?.[0]?.message
  return { text: extractTextContent(choice?.content), usage: payload?.usage }
}

/** 非流式：一次 POST，取 choices[0].message.content；流式：返回文本增量的 async 迭代器 */
export async function runHermesAgent(options: RunHermesAgentOptions & { stream?: false }): Promise<RunHermesAgentResult>
export async function runHermesAgent(options: RunHermesAgentOptions & { stream: true }): Promise<AsyncIterable<string>>
export async function runHermesAgent(options: RunHermesAgentOptions): Promise<RunHermesAgentResult | AsyncIterable<string>> {
  return options.stream ? streamHermesAgent(options) : runHermesAgentOnce(options)
}

/**
 * 流式：POST stream:true，返回文本增量（SSE `data:` chunk 的 choices[0].delta.content）
 * 的 async 迭代器。`data: [DONE]` 终止；空增量与坏帧跳过。
 */
export async function streamHermesAgent(options: RunHermesAgentOptions): Promise<AsyncIterable<string>> {
  const { instructions, messages, signal, timeoutMs = DEFAULT_TIMEOUT_MS, correlationId } = options
  const correlation = correlationId || randomUUID()
  requireHermesConfig()
  logTaskProgress('HermesAgent', 'request', { messages: messages.length, stream: true, correlationId: correlation })
  const response = await callGateway(
    { messages: [{ role: 'system', content: instructions }, ...messages], stream: true },
    signal,
    timeoutMs,
    correlation,
  )
  if (!response.ok) throw await errorForStatus(response)
  if (!response.body) throw new Error('hermes gateway 流式响应缺少 body')

  const body = response.body
  return {
    async *[Symbol.asyncIterator]() {
      const reader = body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let newline = buffer.indexOf('\n')
          while (newline !== -1) {
            const line = buffer.slice(0, newline).trimEnd()
            buffer = buffer.slice(newline + 1)
            const delta = parseSseLine(line)
            if (delta === null) return // data: [DONE]
            if (delta) yield delta
            newline = buffer.indexOf('\n')
          }
        }
      } finally {
        reader.cancel().catch(() => {})
      }
    },
  }
}

/** 单行 SSE 解析：`data: [DONE]` → null（终止）；data JSON → 文本增量（无则空串）；其余行 → 跳过 */
function parseSseLine(line: string): string | null | undefined {
  if (!line.startsWith('data:')) return undefined
  const data = line.slice(5).trim()
  if (data === '[DONE]') return null
  try {
    const chunk = JSON.parse(data)
    const delta = chunk?.choices?.[0]?.delta?.content
    return typeof delta === 'string' ? delta : ''
  } catch {
    return undefined
  }
}
