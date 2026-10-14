import pino from 'pino'
import type { Config } from '../config/env.js'

export type Logger = pino.Logger

/**
 * Structured JSON logging. Request bodies, passwords, Authorization headers,
 * cookies, tokens and verification codes are never logged — log call sites
 * take identifiers and metadata only. Access logs carry path (no query
 * string, so a stray token in a URL can never reach the log).
 */
export function createLogger(config: Config): Logger {
  return pino({
    level: config.LOG_LEVEL,
    base: { service: 'bot-backend', env: config.NODE_ENV },
    redact: {
      paths: [
        'password',
        '*.password',
        'authorization',
        '*.authorization',
        'cookie',
        '*.cookie',
        'refresh_token',
        '*.refresh_token',
        'access_token',
        '*.access_token',
        'token',
        '*.token',
      ],
      censor: '[redacted]',
    },
  })
}
