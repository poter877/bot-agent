import { Hono } from 'hono'
import type { RedisClientType } from 'redis'
import type { AppConfig } from '../../config/env.js'
import type { AppEnv } from '../../shared/context.js'
import { isServicePrincipal, requireAuthContext } from '../../shared/context.js'
import { HttpApiError, assertSameOrigin } from '../../shared/http.js'
import type { Logger } from '../../shared/logger.js'
import { ToolsCatalogError, parseToolsSearchCatalog, resolveSearchEntry } from './catalog.js'

/**
 * POST /api/tools/search — unified web search over server-held Tavily / Brave
 * keys: the client stays keyless and names at most a catalog id. Admission
 * ladder as the media tree — auth + entry-ip flood guard + tools-scope
 * per-user budget (see mount.ts), body/catalog validation, Origin — settled
 * BEFORE the vendor call; vendor failures answer as a clean 502 with none of
 * the vendor's text. Each request is counted per user/day in Redis
 * (tools:usage:<uid>:<day>) and the inbound X-Correlation-Id (the sanitized
 * echo from middleware/correlationId.ts) rides the vendor hop verbatim.
 */

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search'
const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search'

/** Outbound vendor budget (task contract: 15s hard cap per provider call). */
export const TOOLS_SEARCH_VENDOR_TIMEOUT_MS = 15_000
/** Processing budget the mount registers for the /api/tools tree (vendor cap + margin). */
export const TOOLS_REQUEST_BUDGET_MS = TOOLS_SEARCH_VENDOR_TIMEOUT_MS + 5_000

export interface NormalizedSearchResult {
  title: string
  url: string
  snippet: string
}

export interface ToolsRoutesDeps {
  config: AppConfig
  redis: RedisClientType
  logger: Logger
}

function vendorRows(payload: unknown, pick: (row: Record<string, unknown>) => NormalizedSearchResult, list: (body: Record<string, unknown>) => unknown): NormalizedSearchResult[] {
  if (typeof payload !== 'object' || payload === null) throw new Error('vendor payload is not an object')
  const results = list(payload as Record<string, unknown>)
  if (!Array.isArray(results)) throw new Error('vendor payload missing results[]')
  return results
    .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
    .map(pick)
}

async function tavilySearch(key: string, query: string, limit: number, signal: AbortSignal, correlationId: string | undefined): Promise<NormalizedSearchResult[]> {
  const response = await fetch(TAVILY_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${key}`,
      ...(correlationId !== undefined ? { 'X-Correlation-Id': correlationId } : {}),
    },
    body: JSON.stringify({ query, max_results: limit }),
    signal,
  })
  if (!response.ok) throw new Error(`tavily HTTP ${response.status}`)
  return vendorRows(
    await response.json(),
    (row) => ({ title: String(row['title'] ?? ''), url: String(row['url'] ?? ''), snippet: String(row['content'] ?? '') }),
    (body) => body['results'],
  )
}

async function braveSearch(key: string, query: string, limit: number, signal: AbortSignal, correlationId: string | undefined): Promise<NormalizedSearchResult[]> {
  const url = new URL(BRAVE_SEARCH_URL)
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(limit))
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': key,
      ...(correlationId !== undefined ? { 'X-Correlation-Id': correlationId } : {}),
    },
    signal,
  })
  if (!response.ok) throw new Error(`brave HTTP ${response.status}`)
  return vendorRows(
    await response.json(),
    (row) => ({ title: String(row['title'] ?? ''), url: String(row['url'] ?? ''), snippet: String(row['description'] ?? '') }),
    (body) => (body['web'] as Record<string, unknown> | undefined)?.['results'],
  )
}

/** One vendor call within the 15s cap; the inbound request's abort signal is
 * honoured alongside it so a client disconnect still cancels the vendor hop. */
async function runVendorSearch(
  provider: 'tavily' | 'brave', key: string, query: string, limit: number, signal: AbortSignal, correlationId: string | undefined,
): Promise<NormalizedSearchResult[]> {
  const timeoutSignal = AbortSignal.any([signal, AbortSignal.timeout(TOOLS_SEARCH_VENDOR_TIMEOUT_MS)])
  return provider === 'tavily'
    ? tavilySearch(key, query, limit, timeoutSignal, correlationId)
    : braveSearch(key, query, limit, timeoutSignal, correlationId)
}

/** Per user/day ledger, same shape as the media usage feed (recordMediaUsage). */
async function recordToolsUsage(redis: RedisClientType, userId: string, providerId: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  const key = `tools:usage:${userId}:${day}`
  try {
    await redis.hIncrBy(key, 'requests', 1)
    await redis.hIncrBy(key, `provider:${providerId}`, 1)
    await redis.expire(key, 90 * 24 * 3600)
  } catch {
    // Usage bookkeeping is best-effort; the access log is the fallback source.
  }
}

export function createToolsRoutes(deps: ToolsRoutesDeps): Hono<AppEnv> {
  const { config, redis, logger } = deps
  // The catalog is env-driven and boot-validated: a malformed TOOLS_SEARCH_CATALOG
  // aborts startup instead of surfacing per-request 500s.
  const catalog = parseToolsSearchCatalog(config.TOOLS_SEARCH_CATALOG)

  const routes = new Hono<AppEnv>()

  routes.post('/search', async (c) => {
    const auth = requireAuthContext(c)
    // 服务主体是服务器到服务器调用（hermes 的 account-backend 会话同样自带
    // 匹配的 Origin），浏览器会话则沿用媒体树的同源约束。
    if (!isServicePrincipal(auth)) assertSameOrigin(c, new URL(config.BETTER_AUTH_URL).origin)

    const body = await c.req.json().catch(() => null)
    if (body === null) {
      throw new HttpApiError(400, 'invalid_json', 'Request body is not valid JSON.')
    }
    const raw = body as Record<string, unknown>
    const query = typeof raw['query'] === 'string' ? raw['query'].trim() : ''
    if (query === '' || query.length > 2_000) {
      throw new HttpApiError(400, 'validation_failed', 'query is required (max 2000 chars)')
    }
    let limit = 5
    if (raw['limit'] !== undefined) {
      const value = raw['limit']
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10) {
        throw new HttpApiError(400, 'validation_failed', 'limit must be an integer 1..10')
      }
      limit = value
    }
    const provider = typeof raw['provider'] === 'string' && raw['provider'].trim() !== '' ? raw['provider'].trim() : undefined

    let resolved
    try {
      resolved = resolveSearchEntry(catalog, provider, config)
    } catch (error) {
      if (error instanceof ToolsCatalogError) {
        throw new HttpApiError(error.status, error.code, error.message)
      }
      throw error
    }

    try {
      const results = await runVendorSearch(
        resolved.entry.provider, resolved.key, query, limit, c.req.raw.signal, c.get('correlationId'),
      )
      logger.info({ requestId: c.get('requestId'), userId: auth.userId, provider: resolved.entry.id, results: results.length }, 'tools search served')
      await recordToolsUsage(redis, auth.userId, resolved.entry.id)
      return c.json({ ok: true, provider: resolved.entry.id, results })
    } catch (error) {
      if (error instanceof HttpApiError) throw error
      logger.warn({ requestId: c.get('requestId'), provider: resolved.entry.id, err: error }, 'tools search vendor call failed')
      throw new HttpApiError(502, 'internal_error', 'Web search failed.')
    }
  })

  return routes
}
