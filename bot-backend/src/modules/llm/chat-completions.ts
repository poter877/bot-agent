import { Hono } from 'hono'
import { generateText, streamText, type LanguageModel, type ModelMessage, type TextStreamPart } from 'ai'
import type { RedisClientType } from 'redis'
import type { AppConfig } from '../../config/env.js'
import type { Db } from '../../db/client.js'
import type { AppEnv } from '../../shared/context.js'
import { isServicePrincipal, requireAuthContext } from '../../shared/context.js'
import { HttpApiError } from '../../shared/http.js'
import type { Logger } from '../../shared/logger.js'
import type { CatalogEntry, CatalogStore } from './catalog.js'
import { CatalogError, resolveCatalogEntry } from './catalog.js'
import type { ModelResolver } from './providers.js'
import { createModelResolver } from './providers.js'
import { enforceQuota } from './quota.js'
import { recordRequestLog } from './requestLog.js'
import { waitForStreamEvent } from './stream-wait.js'
import { ConcurrencyGuard, recordStreamUsage, type UpstreamUsage } from './usage.js'
import {
  ChunkBuilder,
  chatCompletionRequestSchema,
  finishReasonOf,
  maxOutputTokensOf,
  stopSequencesOf,
  toModelMessages,
  toToolChoice,
  toTools,
  usageOf,
  type ChatCompletionRequest,
} from './openai-wire.js'

/**
 * POST /api/llm/chat/completions — the OpenAI-compatible dialect for
 * server-to-server clients (ai-drama 的 mastra agents). Same engine and
 * admission as /api/llm/stream — catalog, quota, concurrency, request log,
 * usage — but the wire speaks chat-completions so stock OpenAI clients
 * connect unchanged. Internal-service principals only: browsers have
 * /api/llm/stream, and this route never becomes a CSRF-reachable surface.
 */

export interface ChatCompletionsDeps {
  config: AppConfig
  db: Db
  redis: RedisClientType
  logger: Logger
  modelResolver?: ModelResolver
  catalog?: CatalogEntry[]
  catalogStore?: CatalogStore
}

interface ChatContext {
  requestId: string
  auth: ReturnType<typeof requireAuthContext>
  modelId: string
  startedAt: number
}

async function upsertFromFinish(part: Extract<TextStreamPart<never>, { type: 'finish' }>): Promise<UpstreamUsage> {
  const usage = part.totalUsage
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
  }
}

async function* pumpChatStream(
  stream: AsyncIterable<TextStreamPart<never>>,
  ctx: ChatContext,
  timings: { firstEventTimeoutMs: number; idleTimeoutMs: number; maxDurationMs: number },
  hooks: {
    onDeadline: () => void
    onError: (error: unknown) => void
    onSettled: (outcome: { status: 'complete' | 'failed'; usage?: UpstreamUsage; finishReason?: string }) => Promise<void>
  },
): AsyncGenerator<string, void, undefined> {
  const chunks = new ChunkBuilder(`chatcmpl-${ctx.requestId}`, ctx.modelId)
  const deadlineAt = ctx.startedAt + timings.maxDurationMs
  let lastEventAt = Date.now()
  let usage: UpstreamUsage | undefined
  let finishReason: string | undefined
  let failed: string | undefined

  const iterator = stream[Symbol.asyncIterator]()
  let pending: Promise<IteratorResult<TextStreamPart<never>>> | undefined
  try {
    while (true) {
      const hardDeadline = Math.min(lastEventAt + timings.idleTimeoutMs, deadlineAt)
      const outcome = await waitForStreamEvent((pending ??= iterator.next()), hardDeadline)
      if (outcome.kind === 'wake') {
        hooks.onDeadline()
        failed = Date.now() >= deadlineAt ? 'The request exceeded its maximum duration.' : 'The model stream stalled.'
        yield chunks.error(failed)
        yield chunks.done()
        return
      }
      pending = undefined
      const { value: part, done } = outcome.result
      if (done) break
      lastEventAt = Date.now()
      if (part.type === 'text-delta') {
        yield chunks.textDelta(part.text)
      } else if (part.type === 'tool-call') {
        yield chunks.toolCall(part.toolCallId, part.toolName, part.input)
      } else if (part.type === 'finish') {
        usage = await upsertFromFinish(part)
        finishReason = part.finishReason
      } else if (part.type === 'error') {
        failed = 'The model reported an error.'
        yield chunks.error(failed)
        yield chunks.done()
        return
      }
    }
    if (usage === undefined) {
      failed = 'The model stream ended unexpectedly.'
      yield chunks.error(failed)
    } else {
      yield chunks.finish(finishReasonOf(finishReason), usageOf(usage))
    }
    yield chunks.done()
  } catch (error) {
    hooks.onError(error)
    failed = 'Internal streaming failure.'
    yield chunks.error(failed)
    yield chunks.done()
  } finally {
    await hooks.onSettled({ status: failed === undefined && usage !== undefined ? 'complete' : 'failed', usage, finishReason }).catch(() => {})
  }
}

function logger_error(ctx: ChatContext, error: unknown): void {
  void error
}

export function createChatCompletionsRoutes(deps: ChatCompletionsDeps): Hono<AppEnv> {
  const { config, db, redis, logger } = deps
  const catalogStore = deps.catalogStore
  const loadCatalog = deps.catalog
    ? async () => deps.catalog!
    : catalogStore
      ? () => catalogStore.load()
      : async () => {
          const { parseModelCatalog } = await import('./catalog.js')
          return parseModelCatalog(config.LLM_MODEL_CATALOG)
        }
  const providerKeys = { openai: config.OPENAI_API_KEY, anthropic: config.ANTHROPIC_API_KEY, google: config.GOOGLE_GENERATIVE_AI_API_KEY }
  const resolveModel = deps.modelResolver ?? createModelResolver(providerKeys)
  const concurrency = new ConcurrencyGuard(redis, config.LLM_STREAM_MAX_CONCURRENT_PER_USER)

  const routes = new Hono<AppEnv>()

  routes.post('/chat/completions', async (c) => {
    const auth = requireAuthContext(c)
    if (!isServicePrincipal(auth)) {
      throw new HttpApiError(403, 'forbidden', 'The chat endpoint serves internal services only.')
    }
    const requestId = c.get('requestId')
    const startedAt = Date.now()

    const body = await c.req.json().catch(() => null)
    if (body === null) throw new HttpApiError(400, 'invalid_json', 'Request body is not valid JSON.')
    const parsed = chatCompletionRequestSchema.safeParse(body)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new HttpApiError(400, 'validation_failed', `Invalid request at ${issue?.path.join('.') ?? '?'}: ${issue?.message ?? 'invalid'}`)
    }
    const request: ChatCompletionRequest = parsed.data

    let entry: CatalogEntry
    try {
      entry = resolveCatalogEntry(await loadCatalog(), request.model, providerKeys)
    } catch (error) {
      if (error instanceof CatalogError) throw new HttpApiError(error.status, error.code, error.message)
      throw error
    }

    const { concurrencyLimit } = await enforceQuota(db, redis, auth.userId, entry.id)
    await concurrency.acquire(auth.userId, concurrencyLimit)

    const releaseOnce = (() => {
      let released = false
      return async () => {
        if (released) return
        released = true
        await concurrency.release(auth.userId)
      }
    })()

    const settle = async (outcome: { status: 'complete' | 'failed'; usage?: UpstreamUsage; finishReason?: string; failureMessage?: string }) => {
      logger.info(
        { requestId, userId: auth.userId, model: entry.id, finish_reason: outcome.finishReason, duration_ms: Date.now() - startedAt, usage: outcome.usage },
        'chat completion finished',
      )
      if (outcome.usage !== undefined) await recordStreamUsage(redis, auth.userId, entry.id, outcome.usage)
      await recordRequestLog(db, {
        requestId, auth, modelId: entry.id, status: outcome.status,
        errorMessage: outcome.failureMessage, finishReason: outcome.finishReason,
        usage: outcome.usage, durationMs: Date.now() - startedAt,
      })
    }

    const timings = {
      firstEventTimeoutMs: config.LLM_STREAM_FIRST_EVENT_TIMEOUT_MS,
      idleTimeoutMs: config.LLM_STREAM_IDLE_TIMEOUT_MS,
      maxDurationMs: config.LLM_STREAM_MAX_DURATION_MS,
    }

    try {
      let model: LanguageModel
      try {
        model = resolveModel(entry)
      } catch (error) {
        logger.error({ requestId, model: entry.id, err: error }, 'chat model resolution failed')
        throw new HttpApiError(503, 'dependency_unavailable', 'The model backend is not available.')
      }

      const params = {
        model,
        messages: toModelMessages(request.messages) as unknown as ModelMessage[],
        ...(toTools(request) !== undefined ? { tools: toTools(request) } : {}),
        ...(toToolChoice(request) !== undefined ? { toolChoice: toToolChoice(request) as never } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.top_p !== undefined ? { topP: request.top_p } : {}),
        ...(maxOutputTokensOf(request) !== undefined
          ? {
              maxOutputTokens:
                entry.maxOutputTokens !== undefined
                  ? Math.min(maxOutputTokensOf(request)!, entry.maxOutputTokens)
                  : maxOutputTokensOf(request),
            }
          : entry.maxOutputTokens !== undefined
            ? { maxOutputTokens: entry.maxOutputTokens }
            : {}),
        ...(stopSequencesOf(request) !== undefined ? { stopSequences: stopSequencesOf(request) } : {}),
        ...(request.seed !== undefined ? { seed: request.seed } : {}),
        maxRetries: 0 as const,
      }

      if (request.stream !== true) {
        const result = await generateText({ ...params, abortSignal: AbortSignal.timeout(timings.maxDurationMs) })
        const usage: UpstreamUsage = {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        }
        await concurrency.release(auth.userId)
        await settle({ status: 'complete', usage, finishReason: result.finishReason })
        return c.json({
          id: `chatcmpl-${requestId}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: entry.id,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: result.text,
                ...(result.toolCalls.length > 0
                  ? {
                      tool_calls: result.toolCalls.map((call) => ({
                        id: call.toolCallId,
                        type: 'function',
                        function: { name: call.toolName, arguments: typeof call.input === 'string' ? call.input : JSON.stringify(call.input ?? {}) },
                      })),
                    }
                  : {}),
              },
              finish_reason: finishReasonOf(result.finishReason),
            },
          ],
          usage: usageOf(usage),
        })
      }

      const upstreamAbort = new AbortController()
      const onClientAbort = () => upstreamAbort.abort()
      c.req.raw.signal.addEventListener('abort', onClientAbort, { once: true })
      const result = streamText({ ...params, abortSignal: upstreamAbort.signal })

      const generator = pumpChatStream(result.stream as AsyncIterable<TextStreamPart<never>>, { requestId, auth, modelId: entry.id, startedAt }, timings, {
        onDeadline: () => upstreamAbort.abort(),
        onError: (error) => logger.error({ requestId, model: entry.id, err: error }, 'chat stream pump failed'),
        onSettled: async (outcome) => {
          c.req.raw.signal.removeEventListener('abort', onClientAbort)
          await settle({ ...outcome, failureMessage: outcome.status === 'failed' ? 'The chat stream failed.' : undefined })
        },
      })

      const encoder = new TextEncoder()
      return c.newResponse(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { value, done } = await generator.next()
              if (done) {
                await releaseOnce()
                controller.close()
                return
              }
              controller.enqueue(encoder.encode(value))
            } catch (error) {
              await releaseOnce()
              throw error
            }
          },
          async cancel() {
            upstreamAbort.abort()
            await generator.return(undefined).catch(() => {})
            await releaseOnce()
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            'x-accel-buffering': 'no',
          },
        },
      )
    } catch (error) {
      await releaseOnce()
      throw error
    }
  })

  return routes
}
