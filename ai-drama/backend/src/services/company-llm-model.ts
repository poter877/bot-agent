/**
 * 公司后端（bot-backend）自定义 AI SDK language model provider。
 *
 * 直连 `POST {baseUrl}/stream`（baseUrl 即配置行里的 `.../api/llm`），消费
 * bot-backend 的原生 AI SDK Core 事件流（SSE：`event: ai-sdk` 帧承载 Core
 * part JSON，`: heartbeat` 注释保活，`event: end` 帧显式终止）。请求体是
 * bot-backend `llmStreamRequestSchema`（src/modules/llm/request.ts）定义的
 * wire 格式——严格校验、未知字段直接 400，所以这里的字段名必须逐字对齐。
 *
 * 为什么是 LanguageModelV3 而不是 V4：ai@7 同时接受 v2/v3/v4，但本文件唯一
 * 的消费路径是 mastra `Agent`（agents/index.ts 等全部经 getTextModel 建模），
 * mastra 1.17 的白名单是 `supportedLanguageModelSpecifications = ["v2","v3"]`，
 * v4 模型会在 resolveModelConfig 处被拒。被替换的 createOpenAI().chat() 产出
 * 的也是 v3，这里保持同一 spec，行为等价替换。
 */
import { APICallError } from '@ai-sdk/provider'
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FilePart,
  LanguageModelV3FinishReason,
  LanguageModelV3FunctionTool,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolCall,
  LanguageModelV3ToolResultOutput,
  LanguageModelV3Usage,
} from '@ai-sdk/provider'

export interface CompanyLanguageModelOptions {
  /** 配置行的 baseUrl，即 `{COMPANY_BACKEND_URL}/api/llm`；本 provider 拼 `/stream`。 */
  baseUrl: string
  /** 内部服务令牌（COMPANY_SERVICE_TOKEN），走 `Authorization: Bearer`。 */
  apiKey: string
  model: string
  /** 文本服务配置的固定温度；设置后覆盖每次调用的 temperature（与原补丁语义一致）。null = 跟随调用方/服务端默认。 */
  temperature?: number | null
  /**
   * 固定输出上限。原 max_tokens 补丁堵的洞还在：Agent 输出含大段规划 + 工具调用，
   * 服务商默认上限（如 DeepSeek 4096）会截断到工具调用永远生不出来。它现在是
   * wire 协议的一等字段（maxOutputTokens），不再是请求体补丁。
   */
  maxOutputTokens?: number
  /** 测试注入点；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch
}

// ---------------------------------------------------------------------------
// wire 请求体形状（对齐 bot-backend src/modules/llm/request.ts —— .strict()，
// 未列出的字段一律不发，否则服务端 400）
// ---------------------------------------------------------------------------

interface WireFileData {
  type: 'data'
  data: string
}
interface WireUrlData {
  type: 'url'
  url: string
}
type WireFilePart = { type: 'file'; mediaType: string; data: WireFileData | WireUrlData; filename?: string }
type WireToolCallPart = { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
type WireReasoningPart = { type: 'reasoning'; text: string }
type WireTextPart = { type: 'text'; text: string }
type WireToolResultOutput =
  | { type: 'text'; value: string }
  | { type: 'json'; value: unknown }
  | { type: 'content'; value: Array<WireTextPart | WireFilePart> }
type WireToolResultPart = { type: 'tool-result'; toolCallId: string; toolName: string; output: WireToolResultOutput }

type WireMessage =
  | { role: 'user'; content: string | Array<WireTextPart | WireFilePart> }
  | { role: 'assistant'; content: string | Array<WireToolCallPart | WireReasoningPart | WireTextPart | WireFilePart> }
  | { role: 'tool'; content: WireToolResultPart[] }

interface WireTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

/** wire finish 帧里的 totalUsage（ai@7 Core LanguageModelUsage 的可序列化形状）。 */
interface WireTotalUsage {
  inputTokens?: number
  outputTokens?: number
  inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  outputTokenDetails?: { textTokens?: number; reasoningTokens?: number }
}

// ---------------------------------------------------------------------------
// V3 prompt → wire 请求体
// ---------------------------------------------------------------------------

function wireFilePart(part: LanguageModelV3FilePart): WireFilePart {
  const { data } = part
  let wireData: WireFileData | WireUrlData
  if (typeof data === 'string') {
    // V3 约定字符串即 base64（不带 data: 前缀），服务端 media.ts 校验一致
    wireData = { type: 'data', data }
  } else if (data instanceof URL) {
    // JSON 里只能放字符串；服务端 zod 把字符串 refine 成 URL 实例
    wireData = { type: 'url', url: data.toString() }
  } else {
    wireData = { type: 'data', data: Buffer.from(data).toString('base64') }
  }
  return { type: 'file', mediaType: part.mediaType, data: wireData, ...(part.filename ? { filename: part.filename } : {}) }
}

// wire 的 file 部件必须有 mediaType，而 URL 变体（file-url/image-url）不带；
// 从扩展名尽力嗅探，嗅探不出退到安全的顶级类型。
const MEDIA_EXT_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav',
}

function sniffMediaType(url: string, fallback: string): string {
  const ext = url.split(/[?#]/)[0].split('.').pop()?.toLowerCase()
  return (ext !== undefined && MEDIA_EXT_TYPES[ext]) || fallback
}

type V3ContentItem = Extract<LanguageModelV3ToolResultOutput, { type: 'content' }>['value'][number]

interface LooseContentItem {
  type: string
  text?: string
  data?: unknown
  mediaType?: string
  filename?: string
  url?: string
}

function wireContentItem(item: V3ContentItem): WireTextPart | WireFilePart | null {
  // ai@7 运行时（嵌套 provider 4.0.27）还会发 3.0.8 类型里不存在的 {type:'file',
  // data: tagged} 变体，按同构形状归一处理，所以这里走宽松形状
  const loose = item as unknown as LooseContentItem
  if (loose.type === 'file' && loose.mediaType) {
    const data = loose.data
    if (typeof data === 'string') return { type: 'file', mediaType: loose.mediaType, data: { type: 'data', data } }
    const tagged = data as { url?: unknown } | null | undefined
    if (tagged && typeof tagged === 'object' && tagged.url instanceof URL) {
      return { type: 'file', mediaType: loose.mediaType, data: { type: 'url', url: tagged.url.toString() } }
    }
    return null
  }
  switch (loose.type) {
    case 'text':
      return { type: 'text', text: loose.text! }
    case 'file-data':
    case 'image-data':
      return { type: 'file', mediaType: loose.mediaType!, data: { type: 'data', data: loose.data as string } }
    case 'file-url':
      return { type: 'file', mediaType: sniffMediaType(loose.url!, 'application/octet-stream'), data: { type: 'url', url: loose.url! } }
    case 'image-url':
      return { type: 'file', mediaType: sniffMediaType(loose.url!, 'image'), data: { type: 'url', url: loose.url! } }
    default:
      // file-id/image-file-id（厂商文件引用）、custom：wire 无载体，丢部件好过断工具循环
      return null
  }
}

function wireToolResultOutput(output: LanguageModelV3ToolResultOutput): WireToolResultOutput {
  switch (output.type) {
    case 'text':
    case 'json':
      return output
    case 'error-text':
      // wire 没有错误变体；错误文本本身就是给模型看的恢复线索，降级为 text
      return { type: 'text', value: output.value }
    case 'error-json':
      return { type: 'json', value: output.value }
    case 'execution-denied':
      // wire 不认识 denied 语义，折叠成模型可读的 JSON，否则模型无从恢复
      return { type: 'json', value: { denied: true, ...(output.reason ? { reason: output.reason } : {}) } }
    case 'content': {
      const value = output.value.flatMap((item): Array<WireTextPart | WireFilePart> => {
        const mapped = wireContentItem(item)
        return mapped ? [mapped] : []
      })
      if (value.length === 0) throw new Error('tool-result content 只含 unsupported 部件，无法映射到公司后端 wire 格式')
      return { type: 'content', value }
    }
  }
}

/** 单个 text 部件折叠成字符串：wire 两种都收，字符串是规范形（也省 token）。 */
function collapseSingleText<T extends { type: string; text?: string }>(parts: T[]): string | T[] {
  return parts.length === 1 && parts[0].type === 'text' ? parts[0].text! : parts
}

function buildWireBody(config: CompanyLanguageModelOptions, callOptions: LanguageModelV3CallOptions): Record<string, unknown> {
  const systemParts: string[] = []
  const messages: WireMessage[] = []
  for (const message of callOptions.prompt) {
    switch (message.role) {
      case 'system':
        // wire 把 system 放顶层字段（request.ts：绝不允许 system-role 消息进会话）
        systemParts.push(message.content)
        break
      case 'user':
        messages.push({
          role: 'user',
          content: typeof message.content === 'string'
            ? message.content
            : collapseSingleText(message.content.map((part): WireTextPart | WireFilePart =>
              part.type === 'text' ? { type: 'text', text: part.text } : wireFilePart(part))),
        })
        break
      case 'assistant': {
        const content = message.content.flatMap((part): Array<WireToolCallPart | WireReasoningPart | WireTextPart | WireFilePart> => {
          switch (part.type) {
            case 'text':
              return [{ type: 'text', text: part.text }]
            case 'reasoning':
              return [{ type: 'reasoning', text: part.text }]
            case 'tool-call':
              return [{ type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, input: part.input }]
            case 'file':
              return [wireFilePart(part)]
            default:
              // assistant tool-result 意味着 provider 执行的工具；本协议里工具只在
              // ai-drama 本地执行，静默丢弃会伪造会话历史，直接报错。
              throw new Error(`assistant ${(part as { type: string }).type} 部件不被公司后端 wire 协议接受`)
          }
        })
        messages.push({ role: 'assistant', content: collapseSingleText(content) })
        break
      }
      case 'tool':
        messages.push({
          role: 'tool',
          content: message.content
            .filter((part): part is Extract<typeof part, { type: 'tool-result' }> => part.type === 'tool-result')
            .map((part): WireToolResultPart => ({
              type: 'tool-result',
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: wireToolResultOutput(part.output),
            })),
        })
        break
    }
  }

  const tools: WireTool[] = []
  for (const tool of callOptions.tools ?? []) {
    if (tool.type !== 'function') throw new Error(`provider tool ${tool.name} 不被公司后端 wire 协议接受`)
    tools.push({
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
    })
  }

  // 固定值优先于调用方：与被删掉的 temperature/max_tokens 补丁的强制覆写语义一致
  const temperature = config.temperature ?? callOptions.temperature
  const maxOutputTokens = config.maxOutputTokens ?? callOptions.maxOutputTokens
  const toolChoice = callOptions.toolChoice === undefined
    ? undefined
    : callOptions.toolChoice.type === 'tool' ? { tool: callOptions.toolChoice.toolName } : callOptions.toolChoice.type

  return {
    model: config.model,
    ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(temperature !== undefined && temperature !== null ? { temperature } : {}),
    ...(callOptions.topP !== undefined ? { topP: callOptions.topP } : {}),
    ...(maxOutputTokens !== undefined && maxOutputTokens !== null ? { maxOutputTokens } : {}),
    ...(callOptions.stopSequences !== undefined ? { stopSequences: callOptions.stopSequences } : {}),
    ...(callOptions.seed !== undefined ? { seed: callOptions.seed } : {}),
  }
}

// ---------------------------------------------------------------------------
// Core part（wire SSE）→ V3 provider stream part
// ---------------------------------------------------------------------------

const FINISH_REASONS = new Set(['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other'])

function wireFinishReason(unified: unknown, raw: unknown): LanguageModelV3FinishReason {
  return {
    // wire 是裸字符串，未知厂商值不能往下游传脏枚举
    unified: typeof unified === 'string' && FINISH_REASONS.has(unified) ? unified as LanguageModelV3FinishReason['unified'] : 'other',
    raw: typeof raw === 'string' ? raw : undefined,
  }
}

function wireUsage(totalUsage: WireTotalUsage | undefined): LanguageModelV3Usage {
  const input = totalUsage?.inputTokenDetails ?? {}
  const output = totalUsage?.outputTokenDetails ?? {}
  return {
    inputTokens: {
      total: totalUsage?.inputTokens,
      noCache: input.noCacheTokens,
      cacheRead: input.cacheReadTokens,
      cacheWrite: input.cacheWriteTokens,
    },
    outputTokens: {
      total: totalUsage?.outputTokens,
      text: output.textTokens,
      reasoning: output.reasoningTokens,
    },
  }
}

function wireToolCallInput(input: unknown): string {
  // provider 层的 tool-call.input 是 stringified JSON；Core 流里已是解析后的对象
  return typeof input === 'string' ? input : JSON.stringify(input ?? null)
}

/** 不认识的 Core part 一律返回 null（start-step/finish-step/source/file/unsupported/…），由调用方跳过。 */
function mapCorePart(part: Record<string, unknown> & { type?: string }): LanguageModelV3StreamPart | null {
  switch (part?.type) {
    case 'start':
      return { type: 'stream-start', warnings: [] }
    case 'text-start':
    case 'text-end':
    case 'reasoning-start':
    case 'reasoning-end':
      return { type: part.type, id: part.id as string }
    case 'text-delta':
    case 'reasoning-delta':
      // Core 事件流里增量字段叫 text，provider 协议叫 delta
      return { type: part.type, id: part.id as string, delta: typeof part.text === 'string' ? part.text : '' }
    case 'tool-call':
      return {
        type: 'tool-call',
        toolCallId: part.toolCallId as string,
        toolName: part.toolName as string,
        input: wireToolCallInput(part.input),
      }
    case 'finish':
      return {
        type: 'finish',
        finishReason: wireFinishReason(part.finishReason, part.rawFinishReason),
        usage: wireUsage(part.totalUsage as WireTotalUsage),
      }
    case 'error': {
      const raw = (part.error as { message?: unknown } | null | undefined)?.message
      const message = typeof raw === 'string' ? raw : '模型流返回错误'
      return { type: 'error', error: new Error(message) }
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// SSE 解析
// ---------------------------------------------------------------------------

interface SseFrame {
  event: string
  data: string
}

/** 按空行切帧；`event:`/多行 `data:`（以 \n 重连）取值，`: comment`（心跳）与其余字段忽略。 */
function parseFrame(block: string): SseFrame | null {
  let event = ''
  const dataLines: string[] = []
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith(':') || line === '') continue
    if (line.startsWith('event:')) event = line.slice(6).trimStart()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
  }
  if (!event && dataLines.length === 0) return null
  return { event, data: dataLines.join('\n') }
}

async function pumpSse(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => 'continue' | 'stop',
  onDied: () => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = parseFrame(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        if (frame && onFrame(frame) === 'stop') return
        boundary = buffer.indexOf('\n\n')
      }
    }
    buffer += decoder.decode()
    const tail = parseFrame(buffer)
    if (tail && onFrame(tail) === 'stop') return
    // bot-backend 保证每个流都有 `end` 终止帧；没有它说明连接半途死了。
    // 决不能让上游死亡被下游读成一次干净的完成。
    onDied()
  } finally {
    reader.cancel().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------

export function createCompanyLanguageModel(options: CompanyLanguageModelOptions): LanguageModelV3 {
  const fetchImpl = options.fetchImpl ?? fetch
  const url = `${options.baseUrl.replace(/\/+$/, '')}/stream`

  async function doStream(callOptions: LanguageModelV3CallOptions): Promise<{ stream: ReadableStream<LanguageModelV3StreamPart> }> {
    const body = JSON.stringify(buildWireBody(options, callOptions))
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    }
    for (const [name, value] of Object.entries(callOptions.headers ?? {})) {
      if (value !== undefined) headers[name] = value
    }
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body,
      signal: callOptions.abortSignal,
    })
    if (!response.ok) {
      // 响应体可能是 HttpApiError JSON；截断进消息方便排障，状态码必须可见
      const detail = (await response.text().catch(() => '')).slice(0, 500)
      throw new APICallError({
        message: `公司后端流式请求失败（HTTP ${response.status}）${detail ? `: ${detail}` : ''}`,
        url,
        requestBodyValues: body,
        statusCode: response.status,
        responseBody: detail,
        isRetryable: response.status === 429 || response.status >= 500,
      })
    }
    if (!response.body) throw new Error('公司后端流式响应缺少 body')

    let closed = false
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        // provider 协议要求 stream-start 打头，先于任何 wire 帧
        controller.enqueue({ type: 'stream-start', warnings: [] } satisfies LanguageModelV3StreamPart)
        const closeWith = (part?: LanguageModelV3StreamPart) => {
          if (closed) return
          closed = true
          try {
            if (part) controller.enqueue(part)
          } finally {
            controller.close()
          }
        }
        void pumpSse(
          response.body!,
          (frame) => {
            if (frame.event === 'end') {
              let payload: { status?: string; error?: { message?: string } } = {}
              try {
                payload = JSON.parse(frame.data)
              } catch {}
              if (payload.status === 'failed') {
                // WHY: failed 决不能当 complete 收尾——这里必须产出 error part，
                // 让 ai/mastra 把这次调用当成失败，而不是一次空的成功。
                closeWith({ type: 'error', error: new Error(payload.error?.message ?? '公司后端模型流失败') })
              } else {
                // complete：completion 语义已由 finish part 携带，干净关流即可
                closeWith()
              }
              return 'stop'
            }
            if (frame.event !== 'ai-sdk') return 'continue'
            let part: Record<string, unknown>
            try {
              part = JSON.parse(frame.data)
            } catch {
              return 'continue' // 坏帧跳过；终止帧缺失时由 onDied 兜底
            }
            const mapped = mapCorePart(part)
            if (mapped && !closed) controller.enqueue(mapped)
            return 'continue'
          },
          () => closeWith({ type: 'error', error: new Error('公司后端模型流在终止帧前断开') }),
        ).catch((error) => {
          if (!closed) controller.error(error)
        })
      },
      cancel() {
        closed = true
      },
    })
    return { stream }
  }

  return {
    specificationVersion: 'v3',
    provider: 'company-backend',
    modelId: options.model,
    supportedUrls: {},
    doStream,
    async doGenerate(callOptions): Promise<LanguageModelV3GenerateResult> {
      const { stream } = await doStream(callOptions)
      const reader = stream.getReader()
      // 文本按块 id 聚合（保序），tool-call 按到达顺序追加
      const textBlocks = new Map<string, string>()
      const toolCalls: LanguageModelV3ToolCall[] = []
      let finish: Extract<LanguageModelV3StreamPart, { type: 'finish' }> | undefined
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        switch (value.type) {
          case 'text-start':
            textBlocks.set(value.id, '')
            break
          case 'text-delta':
            textBlocks.set(value.id, (textBlocks.get(value.id) ?? '') + value.delta)
            break
          case 'tool-call':
            toolCalls.push(value)
            break
          case 'finish':
            finish = value
            break
          case 'error':
            throw value.error
          default:
            break // reasoning 等仅流式语义，generate 结果不聚合
        }
      }
      if (!finish) throw new Error('公司后端模型流没有 finish part，generate 无法成立')
      return {
        content: [
          ...[...textBlocks.values()].filter((text) => text.length > 0).map((text) => ({ type: 'text' as const, text })),
          ...toolCalls,
        ],
        finishReason: finish.finishReason,
        usage: finish.usage,
        warnings: [],
      }
    },
  }
}
