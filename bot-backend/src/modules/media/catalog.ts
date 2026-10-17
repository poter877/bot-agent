import { z } from 'zod'

/**
 * Server-owned media generation catalogs (doc《流式服务端重构》§6 延伸): clients
 * name a catalog id; provider keys and real model ids live only here. Bootstrap
 * from env (LLM_IMAGE_CATALOG / LLM_VIDEO_CATALOG); DB + console CRUD follows
 * the llm_models pattern when the media surface graduates.
 */

const mediaCatalogEntrySchema = z.object({
  id: z.string().min(1).max(200),
  provider: z.enum(['fal', 'openai', 'google', 'xai']),
  model: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  /** Max images per call the server allows for this entry (image only). */
  maxImages: z.number().int().min(1).max(4).optional(),
})

export type MediaCatalogEntry = z.infer<typeof mediaCatalogEntrySchema>
export type MediaKind = 'image' | 'video'

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
