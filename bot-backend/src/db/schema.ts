import { boolean, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Better Auth owned authentication schema (user / session / account /
 * verification). The library generates and manages these tables — do NOT add
 * hand-rolled password hashes, JWT claims or refresh-token columns beside
 * them (doc §6: 认证 Schema 以库生成结果为准).
 */

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  // Better Auth admin() plugin fields (library-owned): the console flips them
  // through auth.api (ban-user / set-role), never with direct UPDATEs.
  role: text('role').notNull().default('user'),
  banned: boolean('banned').notNull().default(false),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  impersonatedBy: text('impersonated_by'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
})

export type User = typeof user.$inferSelect
export type Session = typeof session.$inferSelect

/** One durable desktop per company account. Runtime credentials never live here. */
export const cloudComputer = pgTable('cloud_computer', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().unique().references(() => user.id, { onDelete: 'cascade' }),
  desiredState: text('desired_state').notNull().default('stopped'),
  state: text('state').notNull().default('stopped'),
  generation: integer('generation').notNull().default(0),
  leaseEpoch: integer('lease_epoch').notNull().default(0),
  leaseTokenHash: text('lease_token_hash'),
  leaseSessionId: text('lease_session_id'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  width: integer('width').notNull().default(1440),
  height: integer('height').notNull().default(900),
  lastError: text('last_error'),
  reconcileAfter: timestamp('reconcile_after', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type CloudComputerRow = typeof cloudComputer.$inferSelect

// ── Operations console state (admin-owned; the model gateway enforces it) ──

/**
 * Server-side model directory (doc《流式服务端重构》§7): clients name `id`;
 * the vendor mapping and real model string live only here. The console CRUDs
 * this table; LLM_MODEL_CATALOG is only the empty-table seed.
 */
export const llmModels = pgTable('llm_models', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(), // registry key inside this service
  model: text('model').notNull(), // upstream model string, never echoed to clients
  enabled: boolean('enabled').notNull().default(true),
  displayName: text('display_name'),
  isDefault: boolean('is_default').notNull().default(false),
  contextLength: integer('context_length'),
  capabilities: text('capabilities'), // JSON {tools,vision,video,reasoning}
  maxOutputTokens: integer('max_output_tokens'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type LlmModelRow = typeof llmModels.$inferSelect

/**
 * The media directory — same story as llm_models, one row per client-facing
 * generation model (image/video/speech/transcription kinds). The console CRUDs
 * it; LLM_IMAGE_CATALOG/LLM_VIDEO_CATALOG only seed an empty table.
 */
export const mediaModels = pgTable('media_models', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(), // image | video | speech | transcription
  provider: text('provider').notNull(), // registry key inside this service
  model: text('model').notNull(), // upstream model string, never echoed to clients
  enabled: boolean('enabled').notNull().default(true),
  displayName: text('display_name'),
  maxImages: integer('max_images'), // image only: server-side per-call clamp
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type MediaModelRow = typeof mediaModels.$inferSelect

/**
 * Per-user quota overrides; absent row = service defaults (doc §7: 按认证用户
 * 限制并发、模型访问及额度). null columns mean "not overridden".
 */
export const userQuotas = pgTable('user_quotas', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  dailyTokenLimit: integer('daily_token_limit'),
  concurrencyLimit: integer('concurrency_limit'),
  modelAllowlist: text('model_allowlist'), // JSON array of catalog ids; null = all
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type UserQuotaRow = typeof userQuotas.$inferSelect

/**
 * One row per model-stream request: gateway truth for 失败请求排查 and usage
 * reconciliation. Rejections (quota/permission) land here too — attributed
 * rows only; unauthenticated traffic stays in the access log.
 */
export const llmRequestLog = pgTable(
  'llm_request_log',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id').notNull(),
    /** Caller-chosen trace id from the X-Correlation-Id header (sanitized); null when absent. */
    correlationId: text('correlation_id'),
    userId: text('user_id'),
    sessionId: text('session_id'),
    modelId: text('model_id').notNull(),
    status: text('status').notNull(), // complete | failed | rejected
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    finishReason: text('finish_reason'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    totalTokens: integer('total_tokens'),
    durationMs: integer('duration_ms').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 失败请求页 always scans newest-first; user/model filters are secondary.
    index('llm_request_log_created_at_idx').on(table.createdAt),
    index('llm_request_log_user_idx').on(table.userId),
    index('llm_request_log_status_idx').on(table.status),
    // Correlation tracing: the request page drills from an ai-drama task /
    // hermes turn correlation id into its gateway requests.
    index('llm_request_log_correlation_id_idx').on(table.correlationId),
  ],
)

export type LlmRequestLogRow = typeof llmRequestLog.$inferSelect

// ── 用户自服务层（account portal + API tokens + device login） ──

/**
 * User-owned bearer tokens for programmatic API access (`bat_` prefix). Only
 * the sha256 hash is stored — the plaintext appears exactly once, in the
 * creation response (portal page or JSON API), and can never be recovered.
 * Revocation is a timestamp, not a delete, so usage history stays attributable.
 */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    hash: text('hash').notNull().unique(), // sha256 hex of the full bat_… secret
    name: text('name').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    index('api_tokens_user_idx').on(table.userId),
    index('api_tokens_hash_idx').on(table.hash),
  ],
)

export type ApiTokenRow = typeof apiTokens.$inferSelect

/**
 * Device-login codes for headless terminals (hermes 无头 profile 换令牌，替代
 * 手工 cookie jar 手术). The code itself is only stored hashed; userId stays
 * null until a session-authenticated user approves it on the portal. Expiry
 * and consumption are enforced by query predicates — no cleanup cron: stale
 * rows are filtered out and age away naturally.
 */
export const deviceCodes = pgTable(
  'device_codes',
  {
    id: text('id').primaryKey(),
    codeHash: text('code_hash').notNull().unique(), // sha256 hex of the normalized XXXXXXXX code
    /** Bound at approval time; null until then. */
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    /** Applicant's User-Agent, shown on the approval page. */
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('device_codes_expires_at_idx').on(table.expiresAt)],
)

export type DeviceCodeRow = typeof deviceCodes.$inferSelect
