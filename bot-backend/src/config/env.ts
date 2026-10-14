import { z } from 'zod'

/**
 * Startup-validated configuration. Missing or invalid values abort boot —
 * the service must never start with default secrets or permissive auth.
 * Authentication itself is delegated to Better Auth (register / login /
 * session); this file only carries what the service needs to run.
 */

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

  // Better Auth (register / login / session). No default secret exists.
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  BETTER_AUTH_URL: z.string().url(),
  BETTER_AUTH_TRUSTED_ORIGINS: csvList(),

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
  RATE_LIMIT_USER_MAX: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_USER_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
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
  return Object.freeze(parsed.data)
}

export type Config = AppConfig
