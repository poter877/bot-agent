import { z } from 'zod'
import { filePartSchema, providerOptionsSchema } from './media.js'
import { replayFields, withReplayOptions } from './replay.js'

/**
 * POST /api/llm/stream request contract (doc《流式服务端重构》§4.1): the body
 * is AI SDK input format — ModelMessage JSON plus tool JSON Schemas. The
 * Python client owns the mapping from its internal OpenAI-shaped messages to
 * this format; the server validates strictly and forwards to streamText.
 *
 * unknown fields are rejected, not ignored: a silently dropped generation
 * parameter changes model behaviour without anyone noticing.
 */

const textContent = z.string().max(2_000_000)
const textPart = z.object({ type: z.literal('text'), text: textContent, providerOptions: providerOptionsSchema.optional() }).strict()
const assistantTextPart = z.object({ type: z.literal('text'), text: textContent, ...replayFields }).strict().transform(withReplayOptions)

const toolCallPart = z.object({
  type: z.literal('tool-call'),
  toolCallId: z.string().min(1).max(500),
  toolName: z.string().min(1).max(200),
  input: z.unknown(),
  ...replayFields,
}).transform(withReplayOptions)

const reasoningPart = z.object({
  type: z.literal('reasoning'),
  text: z.string().max(2_000_000),
  ...replayFields,
}).strict().transform(withReplayOptions)

const assistantContent = z.union([textContent, z.array(z.union([textContent.transform((t) => ({ type: 'text' as const, text: t })), assistantTextPart, filePartSchema, toolCallPart, reasoningPart]))])

const toolResultPart = z.object({
  type: z.literal('tool-result'),
  toolCallId: z.string().min(1).max(500),
  toolName: z.string().min(1).max(200),
  output: z.union([
    z.object({ type: z.literal('text'), value: z.string().max(4_000_000) }),
    z.object({ type: z.literal('json'), value: z.unknown() }),
    z.object({ type: z.literal('content'), value: z.array(z.union([textPart, filePartSchema])).min(1).max(1_000) }).strict(),
  ]),
})

// The system prompt rides the dedicated top-level `system` field (doc §4.1),
// never a system-role message inside the conversation.
const messageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.union([textContent, z.array(z.union([textPart, filePartSchema])).min(1).max(1_000)]) }),
  z.object({ role: z.literal('assistant'), content: assistantContent }),
  z.object({ role: z.literal('tool'), content: z.array(toolResultPart).min(1).max(200) }),
])

const toolSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(20_000).optional(),
  /** JSON Schema 2020-12 subset the vendors accept; validated structurally only. */
  inputSchema: z.record(z.string(), z.unknown()),
})

export const llmStreamRequestSchema = z
  .object({
    model: z.string().min(1).max(200),
    system: textContent.optional(),
    messages: z.array(messageSchema).min(1).max(1_000),
    tools: z.array(toolSchema).max(200).optional(),
    toolChoice: z
      .union([z.literal('auto'), z.literal('none'), z.literal('required'), z.object({ tool: z.string().min(1).max(200) })])
      .optional(),
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
    maxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
    stopSequences: z.array(z.string().max(500)).max(10).optional(),
    seed: z.number().int().optional(),
  })
  .strict()

export type LlmStreamRequest = z.infer<typeof llmStreamRequestSchema>
