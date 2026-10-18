import { z } from 'zod'
import { jsonSchema, type ModelMessage, type ToolSet } from 'ai'

/**
 * OpenAI chat-completions wire translation. The endpoint speaks the protocol
 * mastra/OpenAI clients already speak; this module is the only place that
 * knows both shapes. Unknown client fields (enable_thinking, thinking, …)
 * are accepted and ignored — gateways like new-api inject them and the model
 * call must not 400 on them.
 */

export const chatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().min(1).optional(),
  max_completion_tokens: z.number().int().min(1).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  seed: z.number().int().optional(),
  tool_choice: z.union([z.literal('auto'), z.literal('none'), z.literal('required'), z.object({
    type: z.literal('function'),
    function: z.object({ name: z.string() }),
  })]).optional(),
  tools: z.array(z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string(),
      description: z.string().optional(),
      parameters: z.record(z.string(), z.unknown()).optional(),
    }),
  })).optional(),
  messages: z.array(
    z.union([
      z.object({ role: z.literal('system'), content: z.string() }),
      z.object({ role: z.literal('user'), content: z.unknown() }),
      z.object({
        role: z.literal('assistant'),
        content: z.string().nullable().optional(),
        tool_calls: z.array(z.object({
          id: z.string(),
          type: z.literal('function').optional(),
          function: z.object({ name: z.string(), arguments: z.string() }),
        })).optional(),
      }),
      z.object({ role: z.literal('tool'), tool_call_id: z.string(), content: z.unknown() }),
    ]),
  ).min(1),
})

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>

const asText = (content: unknown): string => (typeof content === 'string' ? content : JSON.stringify(content ?? ''))

/** OpenAI messages → AI SDK ModelMessages. Tool results resolve their tool
 * name from the assistant tool_calls that issued the id (AI SDK requires it;
 * OpenAI wires only carry the id). */
export function toModelMessages(messages: ChatCompletionRequest['messages']): ModelMessage[] {
  const toolNames = new Map<string, string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) toolNames.set(call.id, call.function.name)
    }
  }

  return messages.map((message): ModelMessage => {
    if (message.role === 'system') return { role: 'system', content: message.content }
    if (message.role === 'user') {
      if (typeof message.content === 'string') return { role: 'user', content: message.content }
      const parts = Array.isArray(message.content) ? message.content : []
      return {
        role: 'user',
        content: parts.map((part) => {
          const record = part as Record<string, unknown>
          if (record['type'] === 'image_url') {
            const url = (record['image_url'] as Record<string, unknown> | undefined)?.['url']
            return { type: 'image', image: new URL(String(url)) }
          }
          return { type: 'text', text: asText(record['text'] ?? part) }
        }),
      }
    }
    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: message.content ?? '',
        ...(message.tool_calls !== undefined
          ? {
              toolCalls: message.tool_calls.map((call) => {
                let input: unknown = {}
                try {
                  input = JSON.parse(call.function.arguments || '{}')
                } catch {
                  input = {}
                }
                return { type: 'tool-call' as const, toolCallId: call.id, toolName: call.function.name, input }
              }),
            }
          : {}),
      }
    }
    return {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: message.tool_call_id, toolName: toolNames.get(message.tool_call_id) ?? message.tool_call_id, output: { type: 'text', value: asText(message.content) } }],
    }
  })
}

export function toTools(request: ChatCompletionRequest): ToolSet | undefined {
  if (request.tools === undefined || request.tools.length === 0) return undefined
  const tools: ToolSet = {}
  for (const spec of request.tools) {
    tools[spec.function.name] = {
      description: spec.function.description,
      inputSchema: jsonSchema((spec.function.parameters ?? { type: 'object', properties: {} }) as Parameters<typeof jsonSchema>[0]),
    }
  }
  return tools
}

export function toToolChoice(request: ChatCompletionRequest): Parameters<typeof Object>[0] | string | undefined {
  if (request.tool_choice === undefined) return undefined
  if (typeof request.tool_choice === 'string') return request.tool_choice
  return { type: 'tool', toolName: request.tool_choice.function.name }
}

export const stopSequencesOf = (request: ChatCompletionRequest): string[] | undefined =>
  request.stop === undefined ? undefined : (Array.isArray(request.stop) ? request.stop : [request.stop])

export const maxOutputTokensOf = (request: ChatCompletionRequest): number | undefined =>
  request.max_completion_tokens ?? request.max_tokens

// ── Response side ───────────────────────────────────────────────────────────

export type ChatFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter'

export function finishReasonOf(reason: string | undefined): ChatFinishReason {
  switch (reason) {
    case 'length':
      return 'length'
    case 'tool-calls':
      return 'tool_calls'
    case 'content-filter':
      return 'content_filter'
    default:
      return 'stop'
  }
}

export interface ChatUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export function usageOf(totalUsage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): ChatUsage {
  const input = totalUsage.inputTokens ?? 0
  const output = totalUsage.outputTokens ?? 0
  return { prompt_tokens: input, completion_tokens: output, total_tokens: totalUsage.totalTokens ?? input + output }
}

/** One OpenAI SSE chunk. `index` tracks tool calls across the stream. */
export class ChunkBuilder {
  private readonly created: number
  private toolIndex = 0

  constructor(
    private readonly id: string,
    private readonly model: string,
  ) {
    this.created = Math.floor(Date.now() / 1000)
  }

  private chunk(delta: Record<string, unknown>, finishReason: string | null): string {
    return `data: ${JSON.stringify({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`
  }

  textDelta(delta: string): string {
    return this.chunk({ content: delta }, null)
  }

  toolCall(toolCallId: string, toolName: string, input: unknown): string {
    const args = typeof input === 'string' ? input : JSON.stringify(input ?? {})
    return this.chunk(
      { tool_calls: [{ index: this.toolIndex++, id: toolCallId, type: 'function', function: { name: toolName, arguments: args } }] },
      null,
    )
  }

  finish(reason: ChatFinishReason, usage: ChatUsage): string {
    return (
      this.chunk({}, reason) +
      // OpenAI puts usage on a trailing empty-choices chunk (include_usage).
      `data: ${JSON.stringify({
        id: this.id,
        object: 'chat.completion.chunk',
        created: this.created,
        model: this.model,
        choices: [],
        usage,
      })}\n\n`
    )
  }

  error(message: string): string {
    return `data: ${JSON.stringify({ error: { message, type: 'server_error' } })}\n\n`
  }

  done(): string {
    return 'data: [DONE]\n\n'
  }
}
