import { z } from 'zod'

/**
 * Startup-validated configuration. Missing or invalid values abort boot —
 * the service must never start with default secrets, permissive auth, or an
 * unconfigured mail channel. Secrets come from the environment only.
 */

const booleanish = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true')

const csvList = (fallback: string[] = []) =>
  z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value.trim() === '' ? fallback : value.split(',').map((item) => item.trim()).filter(Boolean),
    )

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Authoritative stores
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // Token signing — no default secret exists.
  AUTH_JWT_SECRET: z.string().min(32, 'AUTH_JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().min(1).default('bot-backend'),
  JWT_AUDIENCE: z.string().min(1).default('bot-desktop'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900), // 15 min
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(3600).max(60 * 86400).default(30 * 86400), // 30 days

  // One-time verification / reset tokens (hashes stored server-side)
  VERIFY_TOKEN_TTL_SECONDS: z.coerce.number().int().min(600).max(7 * 86400).default(86400),
  RESET_TOKEN_TTL_SECONDS: z.coerce.number().int().min(600).max(86400).default(3600),
  MAX_TOKEN_VERIFY_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),

  // Request boundary
  CORS_ALLOWED_ORIGINS: csvList(),
  TRUSTED_PROXIES: csvList(), // IPs/CIDRs (IPv4 CIDR, IPv6 exact) allowed to set X-Forwarded-For
  API_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).max(1024 * 1024).default(16 * 1024), // 16 KiB
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(10_000),
  SERVER_GRACEFUL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15_000),

  // Rate limits — initial values; tune under load on the target machines.
  RATE_LIMIT_ENTRY_MAX: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_ENTRY_WINDOW_SECONDS: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_REGISTER_IP_MAX: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_REGISTER_IP_WINDOW_SECONDS: z.coerce.number().int().min(1).default(3600),
  RATE_LIMIT_LOGIN_IP_MAX: z.coerce.number().int().min(1).default(20),
  RATE_LIMIT_LOGIN_IP_WINDOW_SECONDS: z.coerce.number().int().min(1).default(900),
  RATE_LIMIT_LOGIN_ACCOUNT_MAX: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(900),
  RATE_LIMIT_FORGOT_IP_MAX: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_FORGOT_IP_WINDOW_SECONDS: z.coerce.number().int().min(1).default(3600),
  RATE_LIMIT_FORGOT_ACCOUNT_MAX: z.coerce.number().int().min(1).default(5),
  RATE_LIMIT_FORGOT_ACCOUNT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(3600),
  RATE_LIMIT_VERIFY_IP_MAX: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_VERIFY_IP_WINDOW_SECONDS: z.coerce.number().int().min(1).default(3600),
  RATE_LIMIT_USER_MAX: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_USER_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),

  // Argon2id — OWASP minimum (m=19MiB, t=2, p=1); tune on target hardware.
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(8192).max(1_048_576).default(19_456),
  ARGON2_TIME_COST: z.coerce.number().int().min(1).max(10).default(2),
  ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(8).default(1),
  ARGON2_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),

  // Mail channel. `log` is a development transport only: production must
  // configure SMTP so verification / recovery mail is actually delivered.
  MAIL_TRANSPORT: z.enum(['log', 'smtp']).default('log'),
  MAIL_FROM: z.string().min(3),
  APP_BASE_URL: z.string().url(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: booleanish,
  MAIL_OUTBOX_POLL_MS: z.coerce.number().int().min(500).max(600000).default(5000),
  MAIL_OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
})

export type AppConfig = z.infer<typeof envSchema>

interface ConfigIssue {
  path?: PropertyKey[]
  message: string
}

function failBoot(issues: ConfigIssue[]): never {
  const details = issues
    .map((issue) => `  - ${issue.path?.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
  throw new Error(`Invalid configuration, refusing to start:\n${details}`)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    failBoot(parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })))
  }
  const config = parsed.data

  if (config.NODE_ENV === 'production') {
    const productionIssues: ConfigIssue[] = []
    if (config.MAIL_TRANSPORT === 'log') {
      productionIssues.push({
        path: ['MAIL_TRANSPORT'],
        message: 'MAIL_TRANSPORT=log is not allowed in production; configure SMTP',
      })
    }
    if (productionIssues.length > 0) {
      failBoot(productionIssues)
    }
  }

  if (config.MAIL_TRANSPORT === 'smtp' && !config.SMTP_HOST) {
    failBoot([{ path: ['SMTP_HOST'], message: 'SMTP_HOST is required when MAIL_TRANSPORT=smtp' }])
  }

  return Object.freeze(config)
}

export type Config = AppConfig
