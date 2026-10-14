import { bodyLimit } from 'hono/body-limit'
import type { MiddlewareHandler } from 'hono'
import { HttpApiError } from '../shared/http.js'
import type { AppEnv } from '../shared/context.js'

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])
const COMPRESSED_ENCODINGS = new Set(['gzip', 'deflate', 'br', 'zstd', 'compress'])

/**
 * Body policy for the JSON API: reject unsupported media types and compressed
 * bodies before parsing, then hard-cap the raw stream size. Malformed JSON is
 * mapped to 400 invalid_json in the error handler.
 */
export function bodyPolicyMiddleware(maxSizeBytes: number): MiddlewareHandler<AppEnv> {
  const limit = bodyLimit({
    maxSize: maxSizeBytes,
    onError: () => {
      throw new HttpApiError(413, 'payload_too_large', 'Request body exceeds the allowed size.')
    },
  })

  return async (c, next) => {
    if (!BODY_METHODS.has(c.req.method)) {
      await next()
      return
    }
    const contentType = c.req.header('content-type')
    if (contentType === undefined || !contentType.toLowerCase().includes('application/json')) {
      throw new HttpApiError(415, 'unsupported_media_type', 'This API accepts application/json only.')
    }
    const contentEncoding = c.req.header('content-encoding')
    if (contentEncoding !== undefined && contentEncoding.trim().toLowerCase() !== 'identity') {
      // The body is not decoded by this service; a compressed JSON body would
      // otherwise surface as a confusing parse error.
      throw new HttpApiError(415, 'unsupported_media_type', 'Compressed request bodies are not accepted.')
    }
    await limit(c, next)
  }
}
