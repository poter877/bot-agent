import { z } from 'zod'
import type { ZodType } from 'zod'

/**
 * Server-owned tool-gateway directories — the managed tool gateway's capability
 * catalogs (对标 Nous Portal Tool Gateway: 服务端持厂商密钥, 客户端零密钥).
 * Clients name a catalog id or take the priority walk; provider keys live
 * only here. Same env-driven shape and bootstrap story as the media catalogs,
 * minus the DB table while the console CRUD for tool vendors is still
 * outstanding. Capabilities so far: unified search (Tavily/Brave), web
 * extraction (Firecrawl/Jina).
 */

interface CatalogEntry {
  id: string
  enabled: boolean
  /** Priority-walk rank: higher wins, ties keep catalog order. */
  priority?: number
}

const searchCatalogEntrySchema = z.object({
  id: z.string().min(1).max(200),
  provider: z.enum(['tavily', 'brave']),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(1000).optional(),
})

const extractCatalogEntrySchema = z.object({
  id: z.string().min(1).max(200),
  provider: z.enum(['firecrawl', 'jina']),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(1000).optional(),
})

export type SearchProviderName = z.infer<typeof searchCatalogEntrySchema>['provider']
export type ExtractProviderName = z.infer<typeof extractCatalogEntrySchema>['provider']
export type ToolsSearchEntry = z.infer<typeof searchCatalogEntrySchema>
export type ToolsExtractEntry = z.infer<typeof extractCatalogEntrySchema>

export class ToolsCatalogError extends Error {
  readonly status: number
  readonly code: 'model_not_found' | 'model_disabled' | 'provider_key_missing'

  constructor(status: number, code: 'model_not_found' | 'model_disabled' | 'provider_key_missing', message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function parseCatalogEntries<E extends CatalogEntry>(raw: string, entrySchema: ZodType<E>, label: string): E[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${label} env is not valid JSON`)
  }
  const result = z.array(entrySchema).safeParse(parsed)
  if (!result.success) {
    const issue = result.error.issues[0]
    const detail = issue === undefined ? 'unknown issue' : `${issue.path.join('.')} — ${issue.message}`
    throw new Error(`${label} entry invalid: ${detail}`)
  }
  const seen = new Set<string>()
  for (const entry of result.data) {
    const key = entry.id.toLowerCase()
    if (seen.has(key)) {
      throw new Error(`${label} has duplicate id "${entry.id}"`)
    }
    seen.add(key)
  }
  return result.data
}

export function parseToolsSearchCatalog(raw: string): ToolsSearchEntry[] {
  return parseCatalogEntries(raw, searchCatalogEntrySchema, 'tools search catalog')
}

export function parseToolsExtractCatalog(raw: string): ToolsExtractEntry[] {
  return parseCatalogEntries(raw, extractCatalogEntrySchema, 'tools extract catalog')
}

function searchKeyOf(provider: SearchProviderName, config: { TAVILY_API_KEY?: string; BRAVE_API_KEY?: string }): string | undefined {
  return provider === 'tavily' ? config.TAVILY_API_KEY : config.BRAVE_API_KEY
}

function extractKeyOf(provider: ExtractProviderName, config: { FIRECRAWL_API_KEY?: string; JINA_API_KEY?: string }): string | undefined {
  return provider === 'firecrawl' ? config.FIRECRAWL_API_KEY : config.JINA_API_KEY
}

/**
 * Resolve a catalog entry for a request. Resolution order: a client-named
 * catalog id (unknown/disabled/keyless entries fail closed — the client can
 * never supply a key), else the first enabled key-holding entry by priority.
 * No keyless fallback exists on purpose for either capability: DDG-style
 * search rescue and anonymous scraping are hermes-local behaviour, never the
 * gateway's.
 */
function resolveCatalogEntry<E extends CatalogEntry>(
  catalog: E[],
  requestedProvider: string | undefined,
  keyOf: (entry: E) => string | undefined,
  noun: { unknown: (id: string) => string; disabled: (id: string) => string },
): { entry: E; key: string } {
  if (requestedProvider !== undefined) {
    const entry = catalog.find((candidate) => candidate.id.toLowerCase() === requestedProvider.trim().toLowerCase())
    if (entry === undefined) {
      throw new ToolsCatalogError(404, 'model_not_found', noun.unknown(requestedProvider))
    }
    if (!entry.enabled) {
      throw new ToolsCatalogError(403, 'model_disabled', noun.disabled(entry.id))
    }
    const key = keyOf(entry)
    if (!key?.trim()) {
      throw new ToolsCatalogError(503, 'provider_key_missing', 'The tools backend is not configured.')
    }
    return { entry, key }
  }
  // Stable sort, so equal priorities keep catalog order.
  const available = catalog
    .filter((entry) => entry.enabled && keyOf(entry)?.trim())
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  const entry = available[0]
  if (entry === undefined) {
    throw new ToolsCatalogError(503, 'provider_key_missing', 'The tools backend is not configured.')
  }
  return { entry, key: keyOf(entry)! }
}

export interface ResolvedSearchEntry {
  entry: ToolsSearchEntry
  key: string
}

export function resolveSearchEntry(
  catalog: ToolsSearchEntry[],
  requestedProvider: string | undefined,
  config: { TAVILY_API_KEY?: string; BRAVE_API_KEY?: string },
): ResolvedSearchEntry {
  return resolveCatalogEntry(
    catalog,
    requestedProvider,
    (entry) => searchKeyOf(entry.provider, config),
    {
      unknown: (id) => `Unknown search provider "${id}".`,
      disabled: (id) => `Search provider "${id}" is not enabled.`,
    },
  )
}

export interface ResolvedExtractEntry {
  entry: ToolsExtractEntry
  key: string
}

export function resolveExtractEntry(
  catalog: ToolsExtractEntry[],
  requestedProvider: string | undefined,
  config: { FIRECRAWL_API_KEY?: string; JINA_API_KEY?: string },
): ResolvedExtractEntry {
  return resolveCatalogEntry(
    catalog,
    requestedProvider,
    (entry) => extractKeyOf(entry.provider, config),
    {
      unknown: (id) => `Unknown extract provider "${id}".`,
      disabled: (id) => `Extract provider "${id}" is not enabled.`,
    },
  )
}
