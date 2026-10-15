import type { TextStreamPart } from 'ai'

/**
 * SSE transport for the AI SDK Core full event stream (doc《流式服务端重构》§4.2).
 *
 * Every public Core part is forwarded as one frame:
 *
 *   event: ai-sdk
 *   id: <requestId>:<seq>
 *   data: { ...part }
 *
 * The id sequence exists for order checking and de-dup on the client — NOT for
 * resuming a model call after a drop. Heartbeats are SSE comment lines; they
 * keep intermediaries from closing an idle stream and never stand in for real
 * progress.
 */

export const MODEL_STREAM_VERSION = 1

export interface SseFrame {
  event: string
  id: string | null
  data: string
}

export function sseFrame(event: string, id: string | null, data: unknown): SseFrame {
  return { event, id, data: JSON.stringify(data) }
}

export function sseComment(text: string): string {
  // A comment line carries no event; newlines would forge frame boundaries.
  return `: ${text.replaceAll('\n', ' ')}\n\n`
}

export function renderFrame(frame: SseFrame): string {
  let out = ''
  if (frame.id !== null) out += `id: ${frame.id}\n`
  out += `event: ${frame.event}\n`
  for (const line of frame.data.split('\n')) {
    out += `data: ${line}\n`
  }
  return `${out}\n`
}

/** Part types this API does not carry in protocol version 1 (doc §5: extra
 * events are declared, never smuggled through as text). */
const UNSUPPORTED_PART_TYPES = new Set([
  'source',
  'file',
  'reasoning-file',
  'tool-result',
  'tool-error',
  'tool-output-denied',
  'tool-approval-request',
  'tool-approval-response',
  'custom',
  'raw',
])

function unsupportedMarker(part: TextStreamPart<never>): Record<string, unknown> {
  if (part.type === 'file' || part.type === 'reasoning-file') {
    return {
      type: 'unsupported',
      originalType: part.type,
      detail: { mediaType: part.file.mediaType, size: part.file.uint8Array.byteLength },
    }
  }
  return { type: 'unsupported', originalType: part.type, detail: {} }
}

/**
 * Make one Core part JSON-safe. The stream must not silently drop or fake
 * success: `error` is sanitized to {message, status?}; unsupported or
 * non-serializable payloads become explicit `unsupported` markers the client
 * must report, never ignore.
 */
export function toSerializablePart(part: TextStreamPart<never>): Record<string, unknown> {
  if (UNSUPPORTED_PART_TYPES.has(part.type)) {
    return unsupportedMarker(part)
  }
  if (part.type === 'error') {
    const raw = part.error as unknown
    const message = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : 'Upstream request failed.'
    const status =
      typeof raw === 'object' && raw !== null && 'statusCode' in raw && typeof (raw as { statusCode: unknown }).statusCode === 'number'
        ? (raw as { statusCode: number }).statusCode
        : undefined
    return { type: 'error', error: { message: message.slice(0, 2_000), ...(status !== undefined ? { status } : {}) } }
  }
  if (part.type === 'abort') {
    return { type: 'abort', ...(part.reason !== undefined ? { reason: part.reason } : {}) }
  }
  return part as unknown as Record<string, unknown>
}
