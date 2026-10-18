import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../db/client.js'
import { mediaModels } from '../../db/schema.js'

/**
 * Server-owned media generation directory: clients name a catalog id;
 * provider keys and real model ids live only here. The `media_models` table
 * (console CRUD) is the source of truth; LLM_IMAGE_CATALOG /
 * LLM_VIDEO_CATALOG only seed an empty table once — the llm_models story.
 */

const mediaCatalogEntrySchema = z.object({
  id: z.string().min(1).max(200),
  provider: z.enum(['fal', 'openai', 'google', 'xai', 'volcengine', 'minimax', 'aliyun', 'kling']),
  model: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  /** Max images per call the server allows for this entry (image only). */
  maxImages: z.number().int().min(1).max(4).optional(),
})

export type MediaCatalogEntry = z.infer<typeof mediaCatalogEntrySchema>
export type MediaKind = 'image' | 'video'

/** Every kind the directory serves; speech/transcription joined when the
 * directory became the single source of model truth (the audio routes read
 * the catalog instead of hardcoded sets). */
export type MediaModelKind = MediaKind | 'speech' | 'transcription'

const MEDIA_MODEL_KINDS: readonly MediaModelKind[] = ['image', 'video', 'speech', 'transcription']

export function isMediaModelKind(value: string): value is MediaModelKind {
  return (MEDIA_MODEL_KINDS as readonly string[]).includes(value)
}

/** Bootstrap rows for the audio kinds: the closed model families the AI SDK
 * serves today; the console edits them like any other entry afterwards. */
export const DEFAULT_AUDIO_CATALOG: ReadonlyArray<{ id: string; kind: 'speech' | 'transcription'; provider: 'openai'; model: string }> = [
  { id: 'gpt-4o-mini-tts', kind: 'speech', provider: 'openai', model: 'gpt-4o-mini-tts' },
  { id: 'tts-1', kind: 'speech', provider: 'openai', model: 'tts-1' },
  { id: 'tts-1-hd', kind: 'speech', provider: 'openai', model: 'tts-1-hd' },
  { id: 'whisper-1', kind: 'transcription', provider: 'openai', model: 'whisper-1' },
]

export class MediaCatalogError extends Error {
  readonly status: number
  readonly code: 'model_not_found' | 'model_disabled' | 'provider_key_missing'

  constructor(status: number, code: 'model_not_found' | 'model_disabled' | 'provider_key_missing', message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function parseMediaCatalog(raw: string, kind: MediaKind): MediaCatalogEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`media catalog env for ${kind} is not valid JSON`)
  }
  const result = z.array(mediaCatalogEntrySchema).safeParse(parsed)
  if (!result.success) {
    const issue = result.error.issues[0]
    const detail = issue === undefined ? 'unknown issue' : `${issue.path.join('.')} — ${issue.message}`
    throw new Error(`media catalog (${kind}) entry invalid: ${detail}`)
  }
  const seen = new Set<string>()
  for (const entry of result.data) {
    const key = entry.id.toLowerCase()
    if (seen.has(key)) {
      throw new Error(`media catalog (${kind}) has duplicate id "${entry.id}"`)
    }
    seen.add(key)
  }
  return result.data
}

/**
 * Resolve a client-named media model. Unknown/disabled entries and missing
 * provider keys never reach a vendor call — the client can never supply a key.
 */
export function resolveMediaCatalogEntry(
  catalog: MediaCatalogEntry[],
  requestedModel: string,
  providerApiKeys: Readonly<Record<string, string | undefined>>,
): MediaCatalogEntry {
  const entry = catalog.find((candidate) => candidate.id.toLowerCase() === requestedModel.trim().toLowerCase())
  if (entry === undefined) {
    throw new MediaCatalogError(404, 'model_not_found', `Unknown model "${requestedModel}".`)
  }
  if (!entry.enabled) {
    throw new MediaCatalogError(403, 'model_disabled', `Model "${entry.id}" is not enabled.`)
  }
  if (!providerApiKeys[entry.provider]) {
    throw new MediaCatalogError(503, 'provider_key_missing', 'The media backend is not configured.')
  }
  return entry
}

// ── DB-backed directory (console CRUD → gateway reads) ─────────────────────

export interface MediaCatalogUpsert {
  id: string
  kind: MediaModelKind
  provider: string
  model: string
  enabled: boolean
  displayName?: string | null
  maxImages?: number | null
  note?: string | null
}

export type MediaDirectoryEntry = MediaCatalogEntry & { kind: MediaModelKind; displayName: string | null }

function rowToEntry(row: typeof mediaModels.$inferSelect): MediaDirectoryEntry {
  const entry: MediaDirectoryEntry = {
    id: row.id,
    kind: row.kind as MediaModelKind,
    provider: row.provider as MediaCatalogEntry['provider'],
    model: row.model,
    enabled: row.enabled,
    displayName: row.displayName ?? null,
    ...(row.maxImages !== null ? { maxImages: row.maxImages } : {}),
  }
  return entry
}

/**
 * Same shape and contract as the llm CatalogStore: a short in-process TTL
 * over the table so console edits land without redeploying while the hot
 * path stays off Postgres; writes invalidate the local cache immediately.
 */
export class MediaCatalogStore {
  private cache: { entries: MediaDirectoryEntry[]; loadedAt: number } | null = null
  private seeding: Promise<void> | null = null

  constructor(
    private readonly db: Db,
    private readonly seedEntries: ReadonlyArray<{ id: string; kind: MediaModelKind; provider: string; model: string; enabled?: boolean; maxImages?: number }>,
    private readonly ttlMs = 15_000,
  ) {}

  async load(): Promise<MediaDirectoryEntry[]> {
    if (this.cache !== null && Date.now() - this.cache.loadedAt < this.ttlMs) {
      return this.cache.entries
    }
    await this.seedEmptyTable()
    const rows = await this.db.select().from(mediaModels).orderBy(mediaModels.kind, mediaModels.id)
    const entries = rows.map(rowToEntry)
    this.cache = { entries, loadedAt: Date.now() }
    return entries
  }

  async loadKind(kind: MediaKind): Promise<MediaCatalogEntry[]> {
    return (await this.load()).filter((entry) => entry.kind === kind)
  }

  async upsert(entry: MediaCatalogUpsert): Promise<void> {
    const values = {
      id: entry.id.trim(),
      kind: entry.kind,
      provider: entry.provider,
      model: entry.model,
      enabled: entry.enabled,
      displayName: entry.displayName ?? null,
      maxImages: entry.kind === 'image' ? entry.maxImages ?? null : null,
      note: entry.note ?? null,
      updatedAt: new Date(),
    }
    await this.db.insert(mediaModels).values(values).onConflictDoUpdate({ target: mediaModels.id, set: values })
    this.cache = null
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.db.update(mediaModels).set({ enabled, updatedAt: new Date() }).where(eq(mediaModels.id, id.trim()))
    this.cache = null
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(mediaModels).where(eq(mediaModels.id, id.trim()))
    this.cache = null
  }

  /** Seed env catalogs + audio defaults exactly once, and only into an empty
   * table: env is the bootstrap story, the table is the source of truth. */
  private async seedEmptyTable(): Promise<void> {
    if (this.seeding !== null) return this.seeding
    this.seeding = (async () => {
      const existing = await this.db.select({ id: mediaModels.id }).from(mediaModels).limit(1)
      if (existing.length === 0) {
        for (const entry of this.seedEntries) {
          await this.db
            .insert(mediaModels)
            .values({ ...entry, enabled: entry.enabled ?? true, displayName: null, note: null })
            .onConflictDoNothing()
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

/** Public projection for GET /api/media/models: available (enabled +
 * key-holding) entries only; upstream names never leave this module. */
export function publicMediaCatalog(
  entries: ReadonlyArray<MediaDirectoryEntry>,
  providerApiKeys: Readonly<Record<string, string | undefined>>,
) {
  const available = entries.filter((entry) => entry.enabled && providerApiKeys[entry.provider]?.trim())
  return {
    models: available.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      displayName: entry.displayName ?? entry.id,
      ...(entry.kind === 'image' && entry.maxImages !== undefined ? { maxImages: entry.maxImages } : {}),
    })),
  }
}
