import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../db/client.js'
import { llmModels } from '../../db/schema.js'

/**
 * The server-owned model directory (doc《流式服务端重构》§7): clients name a
 * catalog id; the provider kind and the real upstream model string live only
 * here. The durable source is the `llm_models` table CRUDed by the operations
 * console; LLM_MODEL_CATALOG only seeds an empty table once at boot.
 */

const catalogEntrySchema = z.object({
  /** Client-facing id or alias; the only model name a client may send. */
  id: z.string().min(1).max(200),
  /** Provider registry key inside this service (see providers.ts). */
  provider: z.enum(['openai', 'anthropic', 'google']),
  /** The upstream model string sent to the vendor — never echoed to clients. */
  model: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  displayName: z.string().trim().min(1).max(200).optional(),
  default: z.boolean().optional(),
  contextLength: z.number().int().positive().optional(),
  capabilities: z.object({
    tools: z.boolean().optional(),
    vision: z.boolean().optional(),
    video: z.boolean().optional(),
    reasoning: z.boolean().optional(),
  }).optional(),
  /** Server-side output ceiling clamped onto every request. */
  maxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
})

export type CatalogEntry = z.infer<typeof catalogEntrySchema>

export class CatalogError extends Error {
  readonly status: number
  readonly code: 'model_not_found' | 'model_disabled' | 'provider_key_missing'

  constructor(status: number, code: 'model_not_found' | 'model_disabled' | 'provider_key_missing', message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function parseModelCatalog(raw: string): CatalogEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('LLM_MODEL_CATALOG is not valid JSON')
  }
  const result = z.array(catalogEntrySchema).safeParse(parsed)
  if (!result.success) {
    const issue = result.error.issues[0]
    const detail = issue === undefined ? 'unknown issue' : `${issue.path.join('.')} — ${issue.message}`
    throw new Error(`LLM_MODEL_CATALOG entry invalid: ${detail}`)
  }
  const seen = new Set<string>()
  if (result.data.filter((entry) => entry.default).length > 1) {
    throw new Error('LLM_MODEL_CATALOG must have at most one default model')
  }
  for (const entry of result.data) {
    const key = entry.id.toLowerCase()
    if (seen.has(key)) {
      throw new Error(`LLM_MODEL_CATALOG has duplicate id "${entry.id}"`)
    }
    seen.add(key)
  }
  return result.data
}

/** Public projection: upstream names and credentials never leave this module. */
export function publicModelCatalog(catalog: CatalogEntry[], providerApiKeys: Readonly<Record<string, string | undefined>>) {
  const available = catalog.filter((entry) => entry.enabled && providerApiKeys[entry.provider]?.trim())
  return {
    models: available.map((entry) => ({
      id: entry.id,
      displayName: entry.displayName ?? entry.id,
      capabilities: {
        text: true,
        // Existing catalog entries already accepted tools and images. New modalities
        // must be explicitly declared rather than inferred from a vendor name.
        tools: entry.capabilities?.tools ?? true,
        vision: entry.capabilities?.vision ?? true,
        video: entry.capabilities?.video ?? false,
        reasoning: entry.capabilities?.reasoning ?? false,
      },
      ...(entry.contextLength === undefined ? {} : { contextLength: entry.contextLength }),
      ...(entry.maxOutputTokens === undefined ? {} : { maxOutputTokens: entry.maxOutputTokens }),
    })),
    defaultModel: available.find((entry) => entry.default)?.id ?? available[0]?.id ?? null,
  }
}

/**
 * Resolve a client-named model against the catalog. A disabled or unknown
 * model never reaches a vendor call, and the vendor key must already be in
 * the process env — the client can never supply one.
 */
export function resolveCatalogEntry(
  catalog: CatalogEntry[],
  requestedModel: string,
  providerApiKeys: Readonly<Record<string, string | undefined>>,
): CatalogEntry {
  const entry = catalog.find((candidate) => candidate.id.toLowerCase() === requestedModel.trim().toLowerCase())
  if (entry === undefined) {
    throw new CatalogError(404, 'model_not_found', `Unknown model "${requestedModel}".`)
  }
  if (!entry.enabled) {
    throw new CatalogError(403, 'model_disabled', `Model "${entry.id}" is not enabled.`)
  }
  if (!providerApiKeys[entry.provider]) {
    throw new CatalogError(503, 'provider_key_missing', 'The model backend is not configured.')
  }
  return entry
}

// ── DB-backed catalog (console CRUD → gateway reads) ───────────────────────

/** Console-editable fields; note is console-only and never reaches the wire. */
export interface CatalogUpsert {
  id: string
  provider: string
  model: string
  enabled: boolean
  displayName?: string | null
  default?: boolean
  contextLength?: number | null
  capabilities?: { tools?: boolean; vision?: boolean; video?: boolean; reasoning?: boolean } | null
  maxOutputTokens?: number | null
  note?: string | null
}

function rowToEntry(row: typeof llmModels.$inferSelect): CatalogEntry {
  let capabilities: CatalogEntry['capabilities']
  if (row.capabilities) {
    try {
      capabilities = JSON.parse(row.capabilities) as CatalogEntry['capabilities']
    } catch {
      capabilities = undefined
    }
  }
  return {
    id: row.id,
    provider: row.provider as CatalogEntry['provider'],
    model: row.model,
    enabled: row.enabled,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    ...(row.isDefault ? { default: true } : {}),
    ...(row.contextLength !== null ? { contextLength: row.contextLength } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(row.maxOutputTokens !== null ? { maxOutputTokens: row.maxOutputTokens } : {}),
  }
}

function upsertToRow(entry: CatalogUpsert): typeof llmModels.$inferInsert {
  return {
    id: entry.id.trim(),
    provider: entry.provider,
    model: entry.model,
    enabled: entry.enabled,
    displayName: entry.displayName ?? null,
    isDefault: entry.default ?? false,
    contextLength: entry.contextLength ?? null,
    capabilities: entry.capabilities ? JSON.stringify(entry.capabilities) : null,
    maxOutputTokens: entry.maxOutputTokens ?? null,
    note: entry.note ?? null,
    updatedAt: new Date(),
  }
}

/**
 * The gateway's view of the directory: a short in-process TTL over the table
 * so console edits take effect without redeploying, while the hot path does
 * not hit Postgres per model request. All instances converge within the TTL;
 * writes invalidate the local cache immediately.
 */
export class CatalogStore {
  private cache: { entries: CatalogEntry[]; loadedAt: number } | null = null
  private seeding: Promise<void> | null = null

  constructor(
    private readonly db: Db,
    private readonly seedEntries: CatalogEntry[],
    private readonly ttlMs = 15_000,
  ) {}

  async load(): Promise<CatalogEntry[]> {
    if (this.cache !== null && Date.now() - this.cache.loadedAt < this.ttlMs) {
      return this.cache.entries
    }
    await this.seedEmptyTable()
    const rows = await this.db.select().from(llmModels).orderBy(llmModels.id)
    const entries = rows.map(rowToEntry)
    this.cache = { entries, loadedAt: Date.now() }
    return entries
  }

  async upsert(entry: CatalogUpsert): Promise<void> {
    await this.db
      .insert(llmModels)
      .values(upsertToRow(entry))
      .onConflictDoUpdate({ target: llmModels.id, set: upsertToRow(entry) })
    this.cache = null
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.db.update(llmModels).set({ enabled, updatedAt: new Date() }).where(eqId(id))
    this.cache = null
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(llmModels).where(eqId(id))
    this.cache = null
  }

  /** Seed LLM_MODEL_CATALOG rows exactly once, and only into an empty table:
   * the env var is the bootstrap story, the table is the source of truth. */
  private async seedEmptyTable(): Promise<void> {
    if (this.seeding !== null) return this.seeding
    this.seeding = (async () => {
      const existing = await this.db.select({ id: llmModels.id }).from(llmModels).limit(1)
      if (existing.length === 0) {
        for (const entry of this.seedEntries) {
          await this.db.insert(llmModels).values(upsertToRow({ ...entry, enabled: entry.enabled ?? true })).onConflictDoNothing()
        }
      }
    })()
    try {
      await this.seeding
    } finally {
      this.seeding = null
    }
  }
}

function eqId(id: string) {
  return eq(llmModels.id, id.trim())
}

