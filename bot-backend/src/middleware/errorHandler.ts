import type { ErrorHandler, NotFoundHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppEnv } from '../shared/context.js'
import { HttpApiError, type ErrorBody } from '../shared/http.js'
import { SECURITY_RESPONSE_HEADERS } from './securityHeaders.js'
import type { Logger } from '../shared/logger.js'

function errorBody(requestId: string, code: ErrorBody['error']['code'], message: string): ErrorBody {
  return { error: { code, message }, request_id: requestId }
}

function jsonResponse(body: ErrorBody, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      // Error responses carry the same security posture as success responses:
      // onError bypasses the middleware chain's post-next() header stage.
      ...SECURITY_RESPONSE_HEADERS,
      ...headers,
    },
  })
}

/**
 * Single error exit for the whole app (app.onError): Hono throws (HTTPException,
 * JSON parse failures), our HttpApiError, and unexpected faults all land here.
 * Unknown errors are logged with stack but reduced to a generic 500 — no
 * stack, SQL or configuration ever reaches the client.
 */
export function errorHandler(logger: Logger): ErrorHandler<AppEnv> {
  return (error, c) => {
    const requestId = c.get('requestId') ?? 'unknown'

    if (error instanceof HttpApiError) {
      return jsonResponse(
        errorBody(requestId, error.code, error.message),
        error.status,
        error.headers,
      )
    }

    if (error instanceof HTTPException) {
      // Framework-thrown exceptions (e.g. body-limit or router-level guards).
      const status = error.status
      if (status === 413) {
        return jsonResponse(errorBody(requestId, 'payload_too_large', 'Request body exceeds the allowed size.'), 413)
      }
      if (status === 400 && error.message === 'Malformed JSON in request body') {
        // Hono's fixed parse-failure message; mapped to the stable contract.
        return jsonResponse(errorBody(requestId, 'invalid_json', 'Request body is not valid JSON.'), 400)
      }
      const message = error.message || ''
      return jsonResponse(
        errorBody(requestId, status >= 500 ? 'internal_error' : 'invalid_request', message !== '' ? message : 'Request failed.'),
        status,
      )
    }

    if (error instanceof SyntaxError) {
      // Malformed JSON surfaced by the body parser.
      return jsonResponse(errorBody(requestId, 'invalid_json', 'Request body is not valid JSON.'), 400)
    }

    logger.error({ request_id: requestId, err: error }, 'unhandled_error')
    return jsonResponse(errorBody(requestId, 'internal_error', 'Internal server error.'), 500)
  }
}

export function notFoundHandler(): NotFoundHandler<AppEnv> {
  return (c) => {
    const requestId = c.get('requestId') ?? 'unknown'
    return jsonResponse(errorBody(requestId, 'not_found', 'Resource not found.'), 404)
  }
}
