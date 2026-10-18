import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { apiTokens, type ApiTokenRow } from '../../db/schema.js'
import { HttpApiError } from '../../shared/http.js'

/**
 * User API tokens (`bat_` prefix) — the programmatic credential for headless
 * clients (hermes 无头 profile 经设备码登录换得，或在门户手工创建). Only the
 * sha256 hash is stored; the plaintext leaves the process exactly once, in the
 * creation response. This module owns generation, lookup and revocation for
 * both the JSON CRUD routes and the device-login exchange.
 */

export const API_TOKEN_PREFIX = 'bat_'

export const MAX_ACTIVE_TOKENS_PER_USER = 20

export function hashApiToken(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** Public projection: never the hash, never the secret. */
export function publicToken(row: ApiTokenRow) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  }
}

export interface CreatedApiToken {
  token: ApiTokenRow
  /** The only time the secret exists in cleartext outside the caller's hands. */
  plaintext: string
}

export async function createApiToken(db: Db, userId: string, name: string): Promise<CreatedApiToken> {
  const active = await db
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
  if (active.length >= MAX_ACTIVE_TOKENS_PER_USER) {
    throw new HttpApiError(409, 'conflict', `At most ${MAX_ACTIVE_TOKENS_PER_USER} active tokens per account.`)
  }
  const plaintext = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  const [row] = await db
    .insert(apiTokens)
    .values({ id: randomUUID(), hash: hashApiToken(plaintext), name, userId })
    .returning()
  return { token: row!, plaintext }
}

/** Active (unrevoked) token lookup for bearer authentication; null when absent/revoked. */
export async function findActiveApiToken(db: Db, secret: string): Promise<ApiTokenRow | null> {
  const rows = await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.hash, hashApiToken(secret)), isNull(apiTokens.revokedAt)))
    .limit(1)
  return rows[0] ?? null
}

export async function listApiTokens(db: Db, userId: string): Promise<ApiTokenRow[]> {
  return db.select().from(apiTokens).where(eq(apiTokens.userId, userId)).orderBy(desc(apiTokens.createdAt))
}

/** Revoke one of the user's own tokens; 404 when the id belongs to someone else or does not exist. */
export async function revokeApiToken(db: Db, userId: string, tokenId: string): Promise<ApiTokenRow> {
  const rows = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .returning()
  if (rows[0] === undefined) {
    // Already-revoked own tokens stay visible (idempotent view), unknown or
    // foreign ids must not leak existence.
    const existing = await db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId)))
      .limit(1)
    if (existing[0] !== undefined) return existing[0]
    throw new HttpApiError(404, 'not_found', 'Token not found.')
  }
  return rows[0]
}
