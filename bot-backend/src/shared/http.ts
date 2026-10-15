/**
 * Stable error codes exposed to clients. Values never leak internals
 * (stacks, SQL, config); detail goes to logs with the request id attached.
 */
export const ERROR_CODES = [
  // 400
  'invalid_request',
  'invalid_json',
  'validation_failed',
  'invalid_token',
  'unsupported_media',
  'media_inline_required',
  // 401/403
  'unauthorized',
  'invalid_credentials',
  'account_not_verified',
  'account_disabled',
  'forbidden',
  // 404/409
  'not_found',
  'model_not_found',
  'model_disabled',
  'model_not_allowed',
  'provider_key_missing',
  'conflict',
  // 413/415
  'payload_too_large',
  'unsupported_media_type',
  // 429/503/500
  'rate_limited',
  'concurrency_limit',
  'quota_exceeded',
  'request_timeout',
  'dependency_unavailable',
  'internal_error',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ErrorBody {
  error: {
    code: ErrorCode
    message: string
  }
  request_id: string
}

export class HttpApiError extends Error {
  readonly status: number
  readonly code: ErrorCode
  readonly headers?: Record<string, string>

  constructor(status: number, code: ErrorCode, message: string, headers?: Record<string, string>) {
    super(message)
    this.name = 'HttpApiError'
    this.status = status
    this.code = code
    this.headers = headers
  }
}

/**
 * Cookie-authenticated mutations (console forms, the model stream) mirror the
 * library's CSRF stance: a first-party server-side client sends Origin = base.
 */
export function assertSameOrigin(c: { req: { header(name: string): string | undefined } }, baseOrigin: string): void {
  const origin = c.req.header('origin')
  if (origin === undefined || origin.trim() === '') {
    throw new HttpApiError(403, 'forbidden', 'Origin header is required.')
  }
  if (origin.trim().replace(/\/+$/, '') !== baseOrigin.replace(/\/+$/, '')) {
    throw new HttpApiError(403, 'forbidden', 'Origin does not match the backend.')
  }
}
