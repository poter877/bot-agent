import { count, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { llmModels, user } from '../../db/schema.js'
import type { Auth } from '../auth/auth.js'
import type { CatalogStore } from '../llm/catalog.js'
import type { CredentialStore } from '../llm/credentials.js'
import { registryNeedsBaseURL, registryProvider } from '../llm/registry.js'

/**
 * 运营后台（HTML 控制台与 JSON API）共享的身份与引导逻辑：
 * - 会话身份：每请求实时复核 role=admin（禁用 cookie 缓存）。
 * - 首启引导：账号由 better-auth 创建（哈希归库），随后在 advisory-lock
 *   事务里复核「仍然零管理员」再提升角色——并发双开只有一方能赢，
 *   输家账号落为普通用户，无越权窗口。
 */

export interface ConsoleIdentity {
  userId: string
  email: string
}

/** True once any role=admin account exists — flips the setup wizard off for good. */
export async function adminExists(db: Db): Promise<boolean> {
  const [row] = await db.select({ n: count() }).from(user).where(eq(user.role, 'admin'))
  return (row?.n ?? 0) > 0
}

/** Fresh role check on every console request (cookie cache disabled). */
export async function consoleIdentity(auth: Auth, headers: Headers): Promise<ConsoleIdentity | null> {
  let result: { user?: { id?: string; email?: string; role?: string } } | null
  try {
    result = (await auth.api.getSession({
      headers,
      query: { disableCookieCache: true },
    })) as unknown as { user?: { id?: string; email?: string; role?: string } } | null
  } catch {
    return null
  }
  const sessionUser = result?.user
  if (!sessionUser?.id || sessionUser.role !== 'admin') return null
  return { userId: sessionUser.id, email: sessionUser.email ?? '' }
}

export interface BootstrapInput {
  email?: string
  password?: string
  confirm?: string
}

/** Validates the setup form; throws plain Errors with operator-facing Chinese messages. */
export function validateBootstrapInput(input: BootstrapInput): { email: string; password: string; name: string } {
  const email = (input.email ?? '').trim().toLowerCase()
  const password = input.password ?? ''
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('邮箱格式不正确')
  if (password.length < 8) throw new Error('密码至少 8 位')
  if (input.confirm !== undefined && password !== input.confirm) throw new Error('两次输入的密码不一致')
  return { email, password, name: email.split('@')[0] || 'admin' }
}

export type BootstrapResult = { ok: true; userId: string } | { ok: false; error: string }

/** Creates the account via better-auth, then promotes it under the bootstrap lock. */
export async function bootstrapFirstAdmin(db: Db, auth: Auth, input: { email: string; password: string; name: string }): Promise<BootstrapResult> {
  const created = await auth.api.signUpEmail({ body: { email: input.email, password: input.password, name: input.name } })
  const userId = created?.user?.id
  if (!userId) return { ok: false, error: '账号创建失败' }
  const promoted = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('bot-backend-admin-bootstrap'))`)
    if (await adminExists(db)) return false
    await tx.update(user).set({ role: 'admin' }).where(eq(user.id, userId))
    return true
  })
  if (!promoted) {
    return { ok: false, error: '管理员已存在（被并发初始化抢先），该账号已按普通用户创建，请联系管理员分配角色。' }
  }
  return { ok: true, userId }
}

// ── 模型目录保存（HTML 控制台与 JSON API 共用）────────────────────────────

export interface ModelUpsertInput {
  id: string
  provider: string
  model: string
  enabled: boolean
  displayName?: string | null
  default?: boolean
  contextLength?: number | string | null
  maxOutputTokens?: number | string | null
  note?: string | null
  baseURL?: string | null
  /** 只写不回显：非空则保存为 (provider, baseURL) 维度的控制台凭证。 */
  apiKey?: string | null
}

function optionalIntField(value: number | string | null | undefined, key: string): number | null {
  const raw = value === null || value === undefined ? '' : String(value).trim()
  if (raw === '') return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${key} 必须是 ≥ 1 的整数`)
  return parsed
}

/** Validates + upserts the catalog entry, sweeping stale defaults and saving the credential. */
export async function saveModelEntry(
  deps: { db: Db; catalogStore: CatalogStore; credentialStore?: CredentialStore },
  input: ModelUpsertInput,
): Promise<void> {
  const id = (input.id ?? '').trim()
  const provider = (input.provider ?? '').trim().toLowerCase()
  const model = (input.model ?? '').trim()
  // provider 为注册表里的 AI SDK 支持标识（zhipuai/moonshotai/deepseek/openai/…）；
  // 留空 baseURL 时回填注册表默认端点，未收录 provider 必须显式填写。
  if (!id || !model || !provider) {
    throw new Error('模型 ID、上游模型串与 Provider 均必填')
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(provider)) {
    throw new Error('Provider 仅允许小写字母、数字与 . _ -')
  }
  const explicitBaseURL = (input.baseURL ?? '').trim().replace(/\/+$/, '')
  const baseURL = explicitBaseURL || registryProvider(provider)?.api?.replace(/\/+$/, '')
  // 原生适配器（openai/anthropic）用 SDK 内置默认端点，无需显式填写。
  if (!baseURL && registryNeedsBaseURL(provider)) {
    throw new Error('该 Provider 未收录默认端点，请填写 Base URL')
  }
  await deps.catalogStore.upsert({
    id,
    provider,
    model,
    baseURL: baseURL || null,
    enabled: input.enabled,
    displayName: (input.displayName ?? '') === '' ? null : String(input.displayName).trim(),
    default: input.default === true,
    contextLength: optionalIntField(input.contextLength, 'contextLength'),
    maxOutputTokens: optionalIntField(input.maxOutputTokens, 'maxOutputTokens'),
    note: (input.note ?? '') === '' ? null : String(input.note).trim(),
  })
  if (input.default === true) {
    // Single-default invariant: the newest default wins.
    await deps.db.update(llmModels).set({ isDefault: false }).where(sql`${llmModels.id} <> ${id} and ${llmModels.isDefault}`)
  }
  if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
    await deps.credentialStore?.upsert(provider, baseURL, input.apiKey.trim())
  }
}
