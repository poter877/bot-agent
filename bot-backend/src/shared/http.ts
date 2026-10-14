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
  // 401/403
  'unauthorized',
  'invalid_credentials',
  'account_not_verified',
  'account_disabled',
  'forbidden',
  // 404/409
  'not_found',
  'conflict',
  // 413/415
  'payload_too_large',
  'unsupported_media_type',
  // 429/503/500
  'rate_limited',
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
