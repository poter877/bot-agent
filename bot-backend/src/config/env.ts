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
  PORT: z.coerce.number().int().min(1).max(65535).default(30172),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Authoritative stores
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // Better Auth (register / login / session). No default secret exists.
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  BETTER_AUTH_URL: z.string().url(),
  BETTER_AUTH_TRUSTED_ORIGINS: csvList(),
  // Operations console bootstrap: an account registered under one of these
  // emails becomes admin (role='admin'). The console manages roles after that.
  BOT_BACKEND_ADMIN_EMAILS: csvList(),

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
  RATE_LIMIT_LLM_STREAM_MAX: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_LLM_STREAM_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),

  // Model stream (doc《流式服务端重构》§4/§7). The catalog is server-owned:
  // clients may only name a catalog id; vendor addresses, keys and the real
  // model strings never leave this process. Vendor keys are optional at boot
  // and required only when a catalog entry references their provider.
  LLM_MODEL_CATALOG: z.string().default('[]'),
  LLM_STREAM_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).max(256 * 1024 * 1024).default(64 * 1024 * 1024), // 64 MiB; includes base64 expansion
  LLM_STREAM_MAX_CONCURRENT_PER_USER: z.coerce.number().int().min(1).default(2),
  LLM_STREAM_FIRST_EVENT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
  LLM_STREAM_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(90_000),
  LLM_STREAM_MAX_DURATION_MS: z.coerce.number().int().min(1000).default(600_000),
  LLM_STREAM_HEARTBEAT_MS: z.coerce.number().int().min(1000).default(15_000),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  // Text-gateway vendor keys whose names come from the models.dev registry
  // (registry env[0] per provider); the console credential store is the
  // primary path and these env names are the per-vendor fallback.
  DEEPSEEK_API_KEY: z.string().optional(),
  MOONSHOT_API_KEY: z.string().optional(),
  ZHIPU_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  MISTRAL_API_KEY: z.string().optional(),
  TOGETHERAI_API_KEY: z.string().optional(),
  FIREWORKS_API_KEY: z.string().optional(),
  COHERE_API_KEY: z.string().optional(),
  PERPLEXITY_API_KEY: z.string().optional(),
  OPENAI_COMPATIBLE_API_KEY: z.string().optional(),
  XAI_API_KEY: z.string().optional(),
  FAL_KEY: z.string().optional(),
  // Async-poll media providers (ai-drama's video/image vendors moved behind
  // the media catalog): keys stay server-side like every other provider.
  VOLCENGINE_API_KEY: z.string().optional(),
  MINIMAX_API_KEY: z.string().optional(),
  DASHSCOPE_API_KEY: z.string().optional(),
  // Kling signs each vendor call with a JWT over the AK/SK pair; the pair is
  // composed server-side, so the split stays in env like every other provider.
  KLING_ACCESS_KEY: z.string().optional(),
  KLING_SECRET_KEY: z.string().optional(),

  // Media generation (image/video) catalogs — same shape and bootstrap story
  // as LLM_MODEL_CATALOG: env seeds the id→provider/model mapping while the
  // provider keys stay server-side (doc《流式服务端重构》§6).
  LLM_IMAGE_CATALOG: z.string().default('[]'),
  LLM_VIDEO_CATALOG: z.string().default('[]'),
  RATE_LIMIT_MEDIA_MAX: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_MEDIA_WINDOW_SECONDS: z.coerce.number().int().min(1).default(3600),
  MEDIA_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(1_800_000).default(600_000),
  MEDIA_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).max(1024 * 1024).default(64 * 1024),
  // Internal service principal for server-to-server callers (ai-drama 等)：
  // `Authorization: Bearer <token>` 调用 /api/media/* 与 /api/llm/*（目录、
  // 配额与用量账本照走），用量记在 MEDIA_SERVICE_USER_ID 名下。
  // INTERNAL_SERVICE_TOKEN 是正名；MEDIA_SERVICE_TOKEN 是已部署的别名，
  // 二者都未设置则相关路由仅接受用户会话。
  INTERNAL_SERVICE_TOKEN: z.string().min(24).optional(),
  MEDIA_SERVICE_TOKEN: z.string().min(24).optional(),
  MEDIA_SERVICE_USER_ID: z.string().min(1).default('company-media'),

  // Managed tool gateway — unified search (the Tool Gateway's first capability:
  // 服务端持厂商密钥，客户端零密钥). Catalog follows the media catalogs' shape
  // ([{id, provider, enabled, priority?}]); keys stay server-side and missing
  // keys fail closed with 503 (no keyless DDG fallback — that is hermes-local).
  TOOLS_SEARCH_CATALOG: z.string().default('[]'),
  TAVILY_API_KEY: z.string().optional(),
  BRAVE_API_KEY: z.string().optional(),
  // Managed tool gateway — web extraction (second capability, same contract:
  // server-held Firecrawl/Jina keys, clients stay keyless). No keyless
  // fallback exists here either — scraping without a key is hermes-local
  // behaviour (plugins/web/keyless_mcp.py), never the gateway's.
  TOOLS_EXTRACT_CATALOG: z.string().default('[]'),
  FIRECRAWL_API_KEY: z.string().optional(),
  JINA_API_KEY: z.string().optional(),
  RATE_LIMIT_TOOLS_MAX: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_TOOLS_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),

  // A private worker owns Docker. The public API never mounts its socket.
  CLOUD_COMPUTER_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  CLOUD_COMPUTER_WORKER_URL: z.string().url().optional(),
  CLOUD_COMPUTER_WORKER_TOKEN: z.string().min(32).optional(),
  CLOUD_COMPUTER_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(600),
  CLOUD_COMPUTER_IP_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(1200),
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
  if (parsed.data.CLOUD_COMPUTER_ENABLED && (!parsed.data.CLOUD_COMPUTER_WORKER_URL || !parsed.data.CLOUD_COMPUTER_WORKER_TOKEN)) {
    failBoot([{ message: 'Cloud computers require CLOUD_COMPUTER_WORKER_URL and CLOUD_COMPUTER_WORKER_TOKEN.' }])
  }
  if (parsed.data.CLOUD_COMPUTER_WORKER_URL) {
    const url = new URL(parsed.data.CLOUD_COMPUTER_WORKER_URL)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      failBoot([{ path: ['CLOUD_COMPUTER_WORKER_URL'], message: 'Use an HTTP(S) origin without credentials, path, query or fragment.' }])
    }
  }
  return Object.freeze(parsed.data)
}

export type Config = AppConfig
