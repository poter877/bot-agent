import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { llmProviderCredentials } from '../../db/schema.js'

/**
 * Console-entered provider credentials, keyed by (provider, base_url) — one
 * credential covers every catalog entry sharing that endpoint. Write-only by
 * contract: list() returns masked hints and keyFor() exists only for the
 * gateway's request path. A short TTL mirrors CatalogStore so console edits
 * land without redeploying; env keys stay the fallback when no row matches.
 */

function normalizeBaseUrl(baseUrl?: string | null): string {
  return (baseUrl ?? '').trim().replace(/\/+$/, '')
}

export interface CredentialHint {
  provider: string
  baseUrl: string
  /** Last 4 chars only — never the full key. */
  hint: string
}

export class CredentialStore {
  private cache: { rows: { provider: string; baseUrl: string; apiKey: string }[]; loadedAt: number } | null = null

  constructor(
    private readonly db: Db,
    private readonly ttlMs = 15_000,
  ) {}

  private async load(): Promise<{ provider: string; baseUrl: string; apiKey: string }[]> {
    if (this.cache !== null && Date.now() - this.cache.loadedAt < this.ttlMs) {
      return this.cache.rows
    }
    const rows = await this.db.select().from(llmProviderCredentials)
    const mapped = rows.map((row) => ({ provider: row.provider, baseUrl: normalizeBaseUrl(row.baseUrl), apiKey: row.apiKey }))
    this.cache = { rows: mapped, loadedAt: Date.now() }
    return mapped
  }

  /** Console write; invalidates the local cache immediately. */
  async upsert(provider: string, baseUrl: string | null | undefined, apiKey: string): Promise<void> {
    const normalized = normalizeBaseUrl(baseUrl)
    await this.db
      .insert(llmProviderCredentials)
      .values({ provider, baseUrl: normalized, apiKey, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [llmProviderCredentials.provider, llmProviderCredentials.baseUrl],
        set: { apiKey, updatedAt: new Date() },
      })
    this.cache = null
  }

  /** Prefetched sync lookup for the hot path (resolveCatalogEntry / resolver are sync). */
  async snapshot(): Promise<(provider: string, baseUrl?: string | null) => string | undefined> {
    const rows = await this.load()
    return (provider: string, baseUrl?: string | null) => {
      const normalized = normalizeBaseUrl(baseUrl)
      return rows.find((row) => row.provider === provider && row.baseUrl === normalized)?.apiKey
    }
  }

  async keyFor(provider: string, baseUrl?: string | null): Promise<string | undefined> {
    const normalized = normalizeBaseUrl(baseUrl)
    const rows = await this.load()
    return rows.find((row) => row.provider === provider && row.baseUrl === normalized)?.apiKey
  }

  async list(): Promise<CredentialHint[]> {
    const rows = await this.load()
    return rows.map((row) => ({
      provider: row.provider,
      baseUrl: row.baseUrl,
      hint: row.apiKey.length > 8 ? `••••${row.apiKey.slice(-4)}` : '••••',
    }))
  }

  async delete(provider: string, baseUrl: string | null | undefined): Promise<void> {
    await this.db.delete(llmProviderCredentials).where(
      and(eq(llmProviderCredentials.provider, provider), eq(llmProviderCredentials.baseUrl, normalizeBaseUrl(baseUrl))),
    )
    this.cache = null
  }
}
