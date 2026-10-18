import { createHash, randomInt, randomUUID } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { deviceCodes, type DeviceCodeRow } from '../../db/schema.js'
import { HttpApiError } from '../../shared/http.js'
import { createApiToken } from './tokens.js'

/**
 * Device-login flow for headless terminals (对标 Nous Portal 的设备码登录)。
 *
 * 用途：hermes 无头 profile 在没有浏览器的机器上运行时，用它换取一个长期
 * API 令牌（bat_…），替代对 Better Auth 会话 cookie 的手工手术：
 *
 *   1. 终端 POST /api/auth/device/code     → 得到 XXXX-XXXX 码 + verify_url
 *   2. 用户浏览器打开 verify_url（/account/device?code=…），登录后点批准
 *   3. 终端轮询 POST /api/auth/device/token → 未批准 400 authorization_pending；
 *      批准且未消费 → 签发一枚 api_token（name=device-<date>）并置 consumedAt
 *
 * code 只以 sha256 落库；过期与重复消费都由查询谓词保证（UPDATE … WHERE
 * consumed_at IS NULL），无清理 cron——过期行被过滤后自然老化。
 */

export const DEVICE_CODE_TTL_SECONDS = 10 * 60

/** No I/L/O/0/1: the code is read off a terminal and retyped by a human. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8

export function normalizeDeviceCode(raw: string): string {
  return raw.toUpperCase().replaceAll(/[\s-]/g, '')
}

export function displayDeviceCode(normalized: string): string {
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`
}

export function hashDeviceCode(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex')
}

export interface CreatedDeviceCode {
  /** Display form XXXX-XXXX. */
  code: string
  expiresInSeconds: number
  row: DeviceCodeRow
}

export async function createDeviceCode(db: Db, userAgent: string | null): Promise<CreatedDeviceCode> {
  let normalized = ''
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    normalized += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  }
  const [row] = await db
    .insert(deviceCodes)
    .values({
      id: randomUUID(),
      codeHash: hashDeviceCode(normalized),
      userAgent: userAgent?.slice(0, 300) ?? null,
      expiresAt: new Date(Date.now() + DEVICE_CODE_TTL_SECONDS * 1000),
    })
    .returning()
  return { code: displayDeviceCode(normalized), expiresInSeconds: DEVICE_CODE_TTL_SECONDS, row: row! }
}

export interface DeviceCodeStatus {
  row: DeviceCodeRow
}

async function findLiveDeviceCode(db: Db, rawCode: string): Promise<DeviceCodeRow> {
  const rows = await db
    .select()
    .from(deviceCodes)
    .where(eq(deviceCodes.codeHash, hashDeviceCode(normalizeDeviceCode(rawCode))))
    .limit(1)
  const row = rows[0]
  if (row === undefined) {
    // Unknown codes answer identically to expired ones' shape; existence is
    // not confirmed to an anonymous poller.
    throw new HttpApiError(404, 'not_found', 'Device code not found.')
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new HttpApiError(400, 'device_code_expired', 'Device code has expired.')
  }
  return row
}

/** Bind the approving user; idempotent for the same user, 409 for another. */
export async function approveDeviceCode(db: Db, userId: string, rawCode: string): Promise<DeviceCodeRow> {
  const row = await findLiveDeviceCode(db, rawCode)
  if (row.consumedAt !== null) {
    throw new HttpApiError(409, 'conflict', 'Device code has already been used.')
  }
  if (row.userId !== null) {
    if (row.userId === userId) return row
    throw new HttpApiError(409, 'conflict', 'Device code was approved by another account.')
  }
  const [updated] = await db
    .update(deviceCodes)
    .set({ userId, approvedAt: new Date() })
    .where(and(eq(deviceCodes.id, row.id), isNull(deviceCodes.userId)))
    .returning()
  if (updated === undefined) {
    // Concurrent approval raced us; report the state it landed in.
    if (row.userId === userId) return row
    throw new HttpApiError(409, 'conflict', 'Device code was approved by another account.')
  }
  return updated
}

/** Anonymous exchange: pending → 400, expired → 400, consumed → 409, fresh approval → a new bat_ token. */
export async function exchangeDeviceCode(db: Db, rawCode: string): Promise<{ plaintext: string; name: string }> {
  const row = await findLiveDeviceCode(db, rawCode)
  if (row.approvedAt === null || row.userId === null) {
    throw new HttpApiError(400, 'authorization_pending', 'Device code is awaiting approval.')
  }
  if (row.consumedAt !== null) {
    throw new HttpApiError(409, 'conflict', 'Device code has already been used.')
  }
  // Conditional update: exactly one poller wins the code.
  const consumed = await db
    .update(deviceCodes)
    .set({ consumedAt: new Date() })
    .where(and(eq(deviceCodes.id, row.id), isNull(deviceCodes.consumedAt)))
    .returning({ id: deviceCodes.id })
  if (consumed.length === 0) {
    throw new HttpApiError(409, 'conflict', 'Device code has already been used.')
  }
  const name = `device-${new Date().toISOString().slice(0, 10)}`
  const created = await createApiToken(db, row.userId, name)
  return { plaintext: created.plaintext, name }
}

/** Load an unexpired code for the portal's approval page (existence is fine to reveal to the logged-in approver). */
export async function loadApprovableDeviceCode(db: Db, rawCode: string): Promise<DeviceCodeRow | null> {
  const rows = await db
    .select()
    .from(deviceCodes)
    .where(and(eq(deviceCodes.codeHash, hashDeviceCode(normalizeDeviceCode(rawCode))), sql`${deviceCodes.expiresAt} > now()`))
    .limit(1)
  return rows[0] ?? null
}
