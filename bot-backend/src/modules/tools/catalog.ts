import { z } from 'zod'

/**
 * Server-owned unified-search directory — the managed tool gateway's first
 * capability (对标 Nous Portal Tool Gateway: 服务端持厂商密钥, 客户端零密钥).
 * Clients name a catalog id or take the priority walk; provider keys live
 * only here. Same env-driven shape and bootstrap story as the media catalogs
 * (TOOLS_SEARCH_CATALOG), minus the DB table while the console CRUD for tool
 * vendors is still outstanding.
 */

const searchCatalogEntrySchema = z.object({
  id: z.string().min(1).max(200),
  provider: z.enum(['tavily', 'brave']),
  enabled: z.boolean().default(true),
  /** Priority-walk rank: higher wins, ties keep catalog order. */
  priority: z.number().int().min(0).max(1000).optional(),
})

export type SearchProviderName = z.infer<typeof searchCatalogEntrySchema>['provider']
export type ToolsSearchEntry = z.infer<typeof searchCatalogEntrySchema>

export class ToolsCatalogError extends Error {
  readonly status: number
  readonly code: 'model_not_found' | 'model_disabled' | 'provider_key_missing'

  constructor(status: number, code: 'model_not_found' | 'model_disabled' | 'provider_key_missing', message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function parseToolsSearchCatalog(raw: string): ToolsSearchEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('tools search catalog env is not valid JSON')
  }
  const result = z.array(searchCatalogEntrySchema).safeParse(parsed)
  if (!result.success) {
    const issue = result.error.issues[0]
    const detail = issue === undefined ? 'unknown issue' : `${issue.path.join('.')} — ${issue.message}`
    throw new Error(`tools search catalog entry invalid: ${detail}`)
  }
  const seen = new Set<string>()
  for (const entry of result.data) {
    const key = entry.id.toLowerCase()
    if (seen.has(key)) {
      throw new Error(`tools search catalog has duplicate id "${entry.id}"`)
    }
    seen.add(key)
  }
  return result.data
}

function apiKeyOf(provider: SearchProviderName, config: { TAVILY_API_KEY?: string; BRAVE_API_KEY?: string }): string | undefined {
  return provider === 'tavily' ? config.TAVILY_API_KEY : config.BRAVE_API_KEY
}

export interface ResolvedSearchEntry {
  entry: ToolsSearchEntry
  key: string
}

/**
 * Resolve the search provider for a request. Resolution order: a client-named
 * catalog id (unknown/disabled/keyless entries fail closed — the client can
 * never supply a key), else the first enabled key-holding entry by priority.
 * No keyless fallback exists on purpose: DDG-style rescue is hermes-local
 * behaviour, never the gateway's.
 */
export function resolveSearchEntry(
  catalog: ToolsSearchEntry[],
  requestedProvider: string | undefined,
  config: { TAVILY_API_KEY?: string; BRAVE_API_KEY?: string },
): ResolvedSearchEntry {
  if (requestedProvider !== undefined) {
    const entry = catalog.find((candidate) => candidate.id.toLowerCase() === requestedProvider.trim().toLowerCase())
    if (entry === undefined) {
      throw new ToolsCatalogError(404, 'model_not_found', `Unknown search provider "${requestedProvider}".`)
    }
    if (!entry.enabled) {
      throw new ToolsCatalogError(403, 'model_disabled', `Search provider "${entry.id}" is not enabled.`)
    }
    const key = apiKeyOf(entry.provider, config)
    if (!key?.trim()) {
      throw new ToolsCatalogError(503, 'provider_key_missing', 'The tools backend is not configured.')
    }
    return { entry, key }
  }
  // Stable sort, so equal priorities keep catalog order.
  const available = catalog
    .filter((entry) => entry.enabled && apiKeyOf(entry.provider, config)?.trim())
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  const entry = available[0]
  if (entry === undefined) {
    throw new ToolsCatalogError(503, 'provider_key_missing', 'The tools backend is not configured.')
  }
  return { entry, key: apiKeyOf(entry.provider, config)! }
}
