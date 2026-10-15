import { Hono } from 'hono'
import { jsonSchema, streamText, tool as defineTool, type LanguageModel, type ModelMessage, type TextStreamPart } from 'ai'
import type { RedisClientType } from 'redis'
import type { AppConfig } from '../../config/env.js'
import type { Db } from '../../db/client.js'
import type { AppEnv } from '../../shared/context.js'
import { requireAuthContext, type AuthContext } from '../../shared/context.js'
import { HttpApiError, assertSameOrigin } from '../../shared/http.js'
import type { Logger } from '../../shared/logger.js'
import type { CatalogEntry, CatalogStore } from './catalog.js'
import { CatalogError, parseModelCatalog, publicModelCatalog, resolveCatalogEntry } from './catalog.js'
import { llmStreamRequestSchema, type LlmStreamRequest } from './request.js'
import { createModelResolver, type ModelResolver } from './providers.js'
import { enforceQuota } from './quota.js'
import { recordRequestLog } from './requestLog.js'
import { directMediaOnly, validateMedia } from './media.js'
import { MODEL_STREAM_VERSION, renderFrame, sseComment, sseFrame, toSerializablePart } from './sse.js'
import { waitForStreamEvent } from './stream-wait.js'
import { ConcurrencyGuard, recordStreamUsage, type UpstreamUsage } from './usage.js'

/**
 * POST /api/llm/stream — single model request over the AI SDK, streamed back
 * as the full Core event feed (doc《流式服务端重构》§4). Authentication,
 * catalog, quota and concurrency are all settled BEFORE the response headers;
 * once SSE is running, failures travel as error parts and a terminal `end`
 * event — the HTTP status is never rewritten mid-stream. Tools arrive as JSON
 * Schema without execute and never run server-side; the local Python agent
 * owns execution (§2: Hono does not run Hermes Agent). Every attributed
 * request lands in llm_request_log (complete / failed / rejected).
 */

export interface LlmRoutesDeps {
  config: AppConfig
  db: Db
  redis: RedisClientType
  logger: Logger
  /** Test seam: defaults to the env-keyed provider registry. */
  modelResolver?: ModelResolver
  /** Test seam: static catalog; production reads the console-owned table. */
  catalog?: CatalogEntry[]
  /** Production catalog source (llm_models table, console CRUD). */
  catalogStore?: CatalogStore
}

function parseBody(raw: unknown): LlmStreamRequest {
  const result = llmStreamRequestSchema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    const detail = issue === undefined ? 'invalid request' : `${issue.path.join('.')}: ${issue.message}`
    throw new HttpApiError(400, 'validation_failed', `Invalid request at ${detail}`)
  }
  return result.data
}

function buildTools(request: LlmStreamRequest): Record<string, ReturnType<typeof defineTool>> | undefined {
  if (request.tools === undefined || request.tools.length === 0) return undefined
  const tools: Record<string, ReturnType<typeof defineTool>> = {}
  for (const spec of request.tools) {
    // No execute: the model call must stop at the tool call (doc §3 step 3).
    tools[spec.name] = defineTool({
      description: spec.description,
      inputSchema: jsonSchema(spec.inputSchema as Parameters<typeof jsonSchema>[0]),
    })
  }
  return tools
}

/** Map the wire's {tool} choice onto the AI SDK's {type:'tool', toolName}. */
function toolChoiceOf(request: LlmStreamRequest): Parameters<typeof streamText>['0']['toolChoice'] {
  const choice = request.toolChoice
  if (choice === undefined || choice === 'auto' || choice === 'none' || choice === 'required') return choice
  return { type: 'tool', toolName: choice.tool }
}

function usageFromFinish(part: Extract<TextStreamPart<never>, { type: 'finish' }>): UpstreamUsage {
  const usage = part.totalUsage
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
  }
}

/** Server-side deadlines (doc §7: separate connect/first-event/idle/total
 * budgets — never one blunt timeout over a long stream). */
interface StreamTimings {
  firstEventTimeoutMs: number
  idleTimeoutMs: number
  maxDurationMs: number
  heartbeatMs: number
}

/** Terminal `end` event payload: the explicit close the client can assert on. */
type EndFrame = { request_id: string; status: 'complete' } | { request_id: string; status: 'failed'; error: { message: string } }

async function* pumpStream(
  stream: AsyncIterable<TextStreamPart<never>>,
  ctx: { requestId: string; auth: AuthContext; modelId: string; timings: StreamTimings; startedAt: number },
  hooks: {
    onDeadline: () => void
    onFinish: (outcome: { status: 'complete' | 'failed'; failureMessage?: string; finishReason?: string; usage?: UpstreamUsage }) => Promise<void>
    onError: (stage: string, error: unknown) => void
  },
): AsyncGenerator<string, void, undefined> {
  const { requestId, timings, startedAt } = ctx
  const deadlineAt = startedAt + timings.maxDurationMs
  let sequence = 0
  let lastEventAt = Date.now()
  let usage: UpstreamUsage | undefined
  let finishReason: string | undefined
  let finished = false
  let failureMessage: string | undefined

  const endFrame = (frame: EndFrame): string =>
    renderFrame(sseFrame('end', `${requestId}:${sequence + 1}`, frame))

  try {
    const iterator = stream[Symbol.asyncIterator]()
    let pending: Promise<IteratorResult<TextStreamPart<never>>> | undefined
    let nextHeartbeatAt = lastEventAt + timings.heartbeatMs
    while (true) {
      const hardDeadline = Math.min(lastEventAt + (sequence === 0 ? timings.firstEventTimeoutMs : timings.idleTimeoutMs), deadlineAt)
      const wakeAt = Math.min(hardDeadline, nextHeartbeatAt)
      const outcome = await waitForStreamEvent(pending ??= iterator.next(), wakeAt)
      if (outcome.kind === 'wake') {
        if (Date.now() >= hardDeadline) {
          hooks.onDeadline()
          const reason =
            Date.now() >= deadlineAt
              ? 'The request exceeded its maximum duration.'
              : sequence === 0
                ? 'The model did not produce its first event in time.'
                : 'The model stream stalled.'
          failureMessage = reason
          yield endFrame({ request_id: requestId, status: 'failed', error: { message: reason } })
          return
        }
        nextHeartbeatAt = Date.now() + timings.heartbeatMs
        yield sseComment('heartbeat')
        continue
      }
      pending = undefined
      const { value: part, done } = outcome.result
      if (done) break
      lastEventAt = Date.now()
      nextHeartbeatAt = lastEventAt + timings.heartbeatMs
      sequence += 1
      if (part.type === 'finish') {
        finished = true
        usage = usageFromFinish(part)
        finishReason = part.finishReason
      }
      yield renderFrame(sseFrame('ai-sdk', `${requestId}:${sequence}`, toSerializablePart(part)))
      if (part.type === 'error') {
        failureMessage = 'The model reported an error.'
        break
      }
      if (part.type === 'abort') {
        failureMessage = 'The model stream was aborted.'
        break
      }
    }
    if (finished) {
      yield endFrame({ request_id: requestId, status: 'complete' })
    } else {
      // Every non-finish outcome closes with an explicit failed sentinel:
      // upstream death between events must never read as a completion.
      yield endFrame({
        request_id: requestId,
        status: 'failed',
        error: { message: failureMessage ?? 'The model stream ended unexpectedly.' },
      })
    }
  } catch (error) {
    hooks.onError('pump', error)
    failureMessage = 'Internal streaming failure.'
    yield endFrame({ request_id: requestId, status: 'failed', error: { message: failureMessage } })
  } finally {
    await hooks
      .onFinish({
        status: finished ? 'complete' : 'failed',
        failureMessage,
        finishReason,
        usage,
      })
      .catch(() => {})
  }
}

export function createLlmRoutes(deps: LlmRoutesDeps): Hono<AppEnv> {
  const { config, db, redis, logger } = deps
  const staticCatalog = deps.catalog ?? parseModelCatalog(config.LLM_MODEL_CATALOG)
  // The test seam wins over the console-owned store so suites pin their own catalog.
  const catalogStore = deps.catalogStore
  const loadCatalog = deps.catalog
    ? async () => deps.catalog!
    : catalogStore
      ? () => catalogStore.load()
      : async () => staticCatalog
  const providerKeys = { openai: config.OPENAI_API_KEY, anthropic: config.ANTHROPIC_API_KEY, google: config.GOOGLE_GENERATIVE_AI_API_KEY }
  const resolveModel = deps.modelResolver ?? createModelResolver(providerKeys)
  const concurrency = new ConcurrencyGuard(redis, config.LLM_STREAM_MAX_CONCURRENT_PER_USER)
  const timings: StreamTimings = {
    firstEventTimeoutMs: config.LLM_STREAM_FIRST_EVENT_TIMEOUT_MS,
    idleTimeoutMs: config.LLM_STREAM_IDLE_TIMEOUT_MS,
    maxDurationMs: config.LLM_STREAM_MAX_DURATION_MS,
    heartbeatMs: config.LLM_STREAM_HEARTBEAT_MS,
  }

  const routes = new Hono<AppEnv>()

  routes.get('/models', async (c) => {
    requireAuthContext(c)
    c.header('Cache-Control', 'private, no-store')
    return c.json(publicModelCatalog(await loadCatalog(), providerKeys))
  })

  routes.post('/stream', async (c) => {
    const auth = requireAuthContext(c)
    const requestId = c.get('requestId')
    const startedAt = Date.now()
    assertSameOrigin(c, new URL(config.BETTER_AUTH_URL).origin)

    // Attributed pre-flight failures land in the request journal, then rethrow.
    const reject = async (error: unknown): Promise<never> => {
      if (error instanceof HttpApiError) {
        await recordRequestLog(db, {
          requestId, auth, modelId: '(unresolved)', status: 'rejected',
          errorCode: error.code, errorMessage: error.message, durationMs: Date.now() - startedAt,
        })
      }
      throw error
    }

    const body = await c.req.json().catch(() => null)
    if (body === null) {
      await reject(new HttpApiError(400, 'invalid_json', 'Request body is not valid JSON.'))
    }
    const request = parseBody(body)
    let entry: CatalogEntry
    try {
      entry = resolveCatalogEntry(await loadCatalog(), request.model, providerKeys)
    } catch (error) {
      if (error instanceof CatalogError) {
        await recordRequestLog(db, {
          requestId, auth, modelId: request.model, status: 'rejected',
          errorCode: error.code, errorMessage: error.message, durationMs: Date.now() - startedAt,
        })
        throw new HttpApiError(error.status, error.code, error.message)
      }
      throw error
    }

    let concurrencyLimit: number | null
    try {
      ({ concurrencyLimit } = await enforceQuota(db, redis, auth.userId, entry.id))
    } catch (error) {
      await recordRequestLog(db, {
        requestId, auth, modelId: entry.id, status: 'rejected',
        errorCode: error instanceof HttpApiError ? error.code : 'internal_error',
        errorMessage: error instanceof HttpApiError ? error.message : undefined,
        durationMs: Date.now() - startedAt,
      })
      throw error
    }

    await concurrency.acquire(auth.userId, concurrencyLimit)

    // The server-side ceiling clamps the client's ask; either alone still applies.
    const maxOutputTokens =
      request.maxOutputTokens !== undefined && entry.maxOutputTokens !== undefined
        ? Math.min(request.maxOutputTokens, entry.maxOutputTokens)
        : (request.maxOutputTokens ?? entry.maxOutputTokens)

    // Cancellation is a chain: client disconnect aborts the request signal,
    // server deadlines abort the controller — both terminate the vendor call.
    const upstreamAbort = new AbortController()
    const onClientAbort = () => upstreamAbort.abort()
    c.req.raw.signal.addEventListener('abort', onClientAbort, { once: true })

    let model: LanguageModel
    try {
      model = resolveModel(entry)
      await validateMedia(request, entry.provider, model)
    } catch (error) {
      await concurrency.release(auth.userId)
      c.req.raw.signal.removeEventListener('abort', onClientAbort)
      if (error instanceof HttpApiError) {
        await recordRequestLog(db, {
          requestId, auth, modelId: entry.id, status: 'rejected',
          errorCode: error.code, errorMessage: error.message, durationMs: Date.now() - startedAt,
        })
        throw error
      }
      logger.error({ requestId, model: entry.id, err: error }, 'llm model resolution failed')
      await recordRequestLog(db, {
        requestId, auth, modelId: entry.id, status: 'rejected',
        errorCode: 'dependency_unavailable', durationMs: Date.now() - startedAt,
      })
      throw new HttpApiError(503, 'dependency_unavailable', 'The model backend is not available.')
    }

    const result = streamText({
      model,
      system: request.system,
      // Structural validation happened above; AI SDK re-validates the wire shape.
      messages: request.messages as unknown as ModelMessage[],
      tools: buildTools(request),
      toolChoice: toolChoiceOf(request),
      temperature: request.temperature,
      topP: request.topP,
      maxOutputTokens,
      stopSequences: request.stopSequences,
      seed: request.seed,
      maxRetries: 0,
      abortSignal: upstreamAbort.signal,
      experimental_download: directMediaOnly,
    })

    const generator = pumpStream(
      result.stream as AsyncIterable<TextStreamPart<never>>,
      { requestId, auth, modelId: entry.id, timings, startedAt },
      {
        onDeadline: () => {
          upstreamAbort.abort()
        },
        onError: (stage, error) => {
          logger.error({ requestId, model: entry.id, stage, err: error }, 'llm stream pump failed')
        },
        onFinish: async (outcome) => {
          c.req.raw.signal.removeEventListener('abort', onClientAbort)
          logger.info(
            {
              requestId,
              userId: auth.userId,
              sessionId: auth.sessionId,
              model: entry.id,
              finish_reason: outcome.finishReason,
              duration_ms: Date.now() - startedAt,
              usage: outcome.usage,
            },
            'llm stream finished',
          )
          await recordStreamUsage(redis, auth.userId, entry.id, outcome.usage)
          await recordRequestLog(db, {
            requestId, auth, modelId: entry.id, status: outcome.status,
            errorMessage: outcome.failureMessage, finishReason: outcome.finishReason,
            usage: outcome.usage, durationMs: Date.now() - startedAt,
          })
        },
      },
    )

    // The slot release lives HERE, not in the generator: a cancel before the
    // first pull never starts the generator body, so a generator-owned
    // `finally` would leak the slot until its safety TTL.
    let released = false
    const releaseOnce = async () => {
      if (released) return
      released = true
      await concurrency.release(auth.userId)
    }

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
          // Client hangup: stop the vendor call, then unwind the pump. When
          // the pump already started, return() runs its finally (usage log);
          // pre-start it completes immediately and releaseOnce still runs.
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
          // Buffering hints: intermediaries must not re-chunk or hold SSE frames.
          'x-accel-buffering': 'no',
          'x-model-stream-version': String(MODEL_STREAM_VERSION),
        },
      },
    )
  })

  return routes
}
