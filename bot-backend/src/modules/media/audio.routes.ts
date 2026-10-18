import { Hono } from 'hono'
import { generateSpeech, transcribe } from 'ai'
import type { RedisClientType } from 'redis'
import type { AppConfig } from '../../config/env.js'
import type { AppEnv } from '../../shared/context.js'
import { isServicePrincipal, requireAuthContext } from '../../shared/context.js'
import { HttpApiError, assertSameOrigin } from '../../shared/http.js'
import type { Logger } from '../../shared/logger.js'
import { MediaCatalogError, resolveMediaCatalogEntry, type MediaCatalogEntry, type MediaDirectoryEntry } from './catalog.js'

/**
 * POST /api/media/speech|transcription — audio generation and transcription
 * over the AI SDK (ai-drama 的配音 / 时码识别出口). OpenAI-family models from
 * the server-held OPENAI_API_KEY; the catalog gate does not apply here because
 * the model families are a closed set (speech: gpt-4o-mini-tts/tts-1/hd,
 * transcription: whisper-1). Usage books like the other media routes.
 */

export interface AudioRoutesDeps {
  config: AppConfig
  redis: RedisClientType
  logger: Logger
  /** Production directory source (speech/transcription kinds). */
  catalogStore?: { load(): Promise<MediaDirectoryEntry[]> }
  /** Test seam: static audio catalog rows (kind speech/transcription). */
  audioCatalog?: Array<{ id: string; kind: 'speech' | 'transcription'; provider: string; model: string; enabled?: boolean }>
  /** Test seams over the AI SDK calls. */
  speechGenerator?: (request: SpeechRequest) => Promise<{ media_type: string; base64: string }>
  transcriber?: (request: { model: string; file: Blob; filename: string }) => Promise<{
    text: string
    segments: Array<{ start: number; end: number; text: string }>
  }>
}

export interface SpeechRequest {
  model: string
  input: string
  voice?: string
  responseFormat: 'mp3' | 'wav'
  speed?: number
}

const TRANSCRIPTION_MAX_BYTES = 24 * 1024 * 1024

/** The audio model families live in the media directory (console CRUD); the
 * gateway fail-closes on anything the directory does not answer for. */
async function audioCatalogOf(deps: AudioRoutesDeps, kind: 'speech' | 'transcription'): Promise<MediaCatalogEntry[]> {
  if (deps.audioCatalog) return deps.audioCatalog.filter((row) => row.kind === kind).map((row) => ({ ...row, enabled: row.enabled ?? true }) as MediaCatalogEntry)
  if (deps.catalogStore) {
    const entries = await deps.catalogStore.load()
    return entries.filter((entry) => entry.kind === kind).map((entry) => ({ ...entry, maxImages: entry.maxImages ?? undefined }))
  }
  throw new HttpApiError(503, 'provider_key_missing', 'The audio directory is not configured.')
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

async function recordUsage(redis: RedisClientType, userId: string, modelId: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  const key = `media:usage:${userId}:${day}`
  try {
    await redis.hIncrBy(key, 'requests', 1)
    await redis.hIncrBy(key, `model:${modelId}`, 1)
    await redis.expire(key, 90 * 24 * 3600)
  } catch {
    // Usage bookkeeping is best-effort; the access log is the fallback source.
  }
}

export function createAudioRoutes(deps: AudioRoutesDeps): Hono<AppEnv> {
  const { config, redis, logger } = deps
  const routes = new Hono<AppEnv>()

  routes.post('/speech', async (c) => {
    const auth = requireAuthContext(c)
    if (!isServicePrincipal(auth)) assertSameOrigin(c, new URL(config.BETTER_AUTH_URL).origin)

    const raw = asRecord(await c.req.json().catch(() => null))
    if (raw === null) throw new HttpApiError(400, 'invalid_json', 'Request body is not valid JSON.')
    const request: SpeechRequest = {
      model: String(raw['model'] ?? ''),
      input: String(raw['input'] ?? ''),
      ...(typeof raw['voice'] === 'string' && raw['voice'] !== '' ? { voice: raw['voice'] } : {}),
      responseFormat: raw['response_format'] === 'wav' ? 'wav' : 'mp3',
      ...(typeof raw['speed'] === 'number' ? { speed: Math.min(4, Math.max(0.25, raw['speed'])) } : {}),
    }
    try {
      resolveMediaCatalogEntry(await audioCatalogOf(deps, 'speech'), request.model, { openai: config.OPENAI_API_KEY })
    } catch (error) {
      if (error instanceof MediaCatalogError) throw new HttpApiError(error.status, error.code, error.message)
      throw error
    }
    if (request.input.trim() === '' || request.input.length > 20_000) {
      throw new HttpApiError(400, 'validation_failed', 'input is required (max 20000 chars)')
    }

    try {
      const audio = deps.speechGenerator
        ? await deps.speechGenerator(request)
        : await defaultSpeech(config, request, c.req.raw.signal)
      logger.info({ requestId: c.get('requestId'), userId: auth.userId, model: request.model }, 'speech generated')
      await recordUsage(redis, auth.userId, request.model)
      return c.json({ ok: true, audio })
    } catch (error) {
      logger.warn({ requestId: c.get('requestId'), model: request.model, err: error }, 'speech generation failed')
      throw new HttpApiError(502, 'internal_error', 'Speech generation failed.')
    }
  })

  routes.post('/transcription', async (c) => {
    const auth = requireAuthContext(c)
    if (!isServicePrincipal(auth)) assertSameOrigin(c, new URL(config.BETTER_AUTH_URL).origin)

    const form = await c.req.formData().catch(() => null)
    if (form === null) throw new HttpApiError(400, 'invalid_json', 'A multipart form with a file field is required.')
    const model = String(form.get('model') ?? '')
    try {
      resolveMediaCatalogEntry(await audioCatalogOf(deps, 'transcription'), model, { openai: config.OPENAI_API_KEY })
    } catch (error) {
      if (error instanceof MediaCatalogError) throw new HttpApiError(error.status, error.code, error.message)
      throw error
    }
    const file = form.get('file')
    if (!(file instanceof File)) throw new HttpApiError(400, 'validation_failed', 'file is required')
    if (file.size > TRANSCRIPTION_MAX_BYTES) throw new HttpApiError(413, 'payload_too_large', 'Audio exceeds 24 MiB.')
    if (!config.OPENAI_API_KEY) throw new HttpApiError(503, 'provider_key_missing', 'The audio backend is not configured.')

    try {
      const transcript = deps.transcriber
        ? await deps.transcriber({ model, file, filename: file.name || 'source.mp3' })
        : await defaultTranscription(config, { model, file, filename: file.name || 'source.mp3' }, c.req.raw.signal)
      logger.info({ requestId: c.get('requestId'), userId: auth.userId, model }, 'transcription generated')
      await recordUsage(redis, auth.userId, model)
      return c.json({ ok: true, ...transcript })
    } catch (error) {
      logger.warn({ requestId: c.get('requestId'), model, err: error }, 'transcription failed')
      throw new HttpApiError(502, 'internal_error', 'Transcription failed.')
    }
  })

  return routes
}

async function defaultSpeech(config: AppConfig, request: SpeechRequest, signal: AbortSignal) {
  const { createOpenAI } = await import('@ai-sdk/openai')
  const openai = createOpenAI({ apiKey: config.OPENAI_API_KEY ?? '' })
  const audio = await generateSpeech({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: openai.speech(request.model) as any,
    text: request.input,
    ...(request.voice !== undefined ? { voice: request.voice as never } : {}),
    ...(request.speed !== undefined ? { speed: request.speed } : {}),
    outputFormat: request.responseFormat === 'wav' ? ('wav' as const) : ('mp3' as const),
    abortSignal: signal,
    maxRetries: 0,
  })
  return { media_type: request.responseFormat === 'wav' ? 'audio/wav' : 'audio/mpeg', base64: Buffer.from(audio.audio.uint8Array).toString('base64') }
}

async function defaultTranscription(
  config: AppConfig,
  request: { model: string; file: Blob; filename: string },
  signal: AbortSignal,
): Promise<{ text: string; segments: Array<{ start: number; end: number; text: string }> }> {
  const { createOpenAI } = await import('@ai-sdk/openai')
  const openai = createOpenAI({ apiKey: config.OPENAI_API_KEY ?? '' })
  const result = await transcribe({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: openai.transcription(request.model) as any,
    audio: new Uint8Array(await request.file.arrayBuffer()),
    abortSignal: signal,
    maxRetries: 0,
  })
  return {
    text: result.text,
    segments: result.segments.map((segment) => ({ start: segment.startSecond, end: segment.endSecond, text: segment.text })),
  }
}
