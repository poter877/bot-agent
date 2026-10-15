import { z } from 'zod'

/**
 * The server-owned model directory (doc《流式服务端重构》§7): clients name a
 * catalog id; the provider kind and the real upstream model string live only
 * here. Adding a same-protocol model is a catalog edit, not a code change.
 *
 * Catalog source is the LLM_MODEL_CATALOG env var (a JSON array) for now —
 * the durable home is a database table once the admin surface exists.
 */

const catalogEntrySchema = z.object({
  /** Client-facing id or alias; the only model name a client may send. */
  id: z.string().min(1).max(200),
  /** Provider registry key inside this service (see providers.ts). */
  provider: z.enum(['openai', 'anthropic']),
  /** The upstream model string sent to the vendor — never echoed to clients. */
  model: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
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
  for (const entry of result.data) {
    const key = entry.id.toLowerCase()
    if (seen.has(key)) {
      throw new Error(`LLM_MODEL_CATALOG has duplicate id "${entry.id}"`)
    }
    seen.add(key)
  }
  return result.data
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
