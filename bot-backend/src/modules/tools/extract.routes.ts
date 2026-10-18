import { Hono } from 'hono'
import type { RedisClientType } from 'redis'
import type { AppConfig } from '../../config/env.js'
import type { AppEnv } from '../../shared/context.js'
import { isServicePrincipal, requireAuthContext } from '../../shared/context.js'
import { HttpApiError, assertSameOrigin } from '../../shared/http.js'
import type { Logger } from '../../shared/logger.js'
import { ToolsCatalogError, parseToolsExtractCatalog, resolveExtractEntry } from './catalog.js'
import { recordToolsUsage } from './search.routes.js'

/**
 * POST /api/tools/extract — unified page extraction over server-held
 * Firecrawl / Jina keys: the client stays keyless and names at most a catalog
 * id. Same admission ladder and contract as /api/tools/search (see
 * search.routes.ts): body/catalog validation and Origin settled BEFORE the
 * vendor call; vendor failures answer as a clean 502 with none of the
 * vendor's text. Content over maxChars is truncated server-side and marked
 * (both the truncated flag and an inline footer, sized so the returned
 * content never exceeds maxChars). Usage rides the same tools:usage ledger
 * and the inbound X-Correlation-Id rides the vendor hop verbatim.
 */

const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v1/scrape'
const JINA_READER_BASE = 'https://r.jina.ai/'

/** Outbound vendor budget (task contract: 20s hard cap per provider call —
 * page rendering is slower than a search round-trip). */
export const TOOLS_EXTRACT_VENDOR_TIMEOUT_MS = 20_000
export const TOOLS_EXTRACT_MAX_CHARS_DEFAULT = 20_000
export const TOOLS_EXTRACT_MAX_CHARS_LIMIT = 100_000

type ExtractFormat = 'markdown' | 'html'

export interface ToolsExtractRoutesDeps {
  config: AppConfig
  redis: RedisClientType
  logger: Logger
}

function truncationFooter(maxChars: number): string {
  return `\n\n[... page truncated server-side at ${maxChars.toLocaleString('en-US')} chars; `
    + `raise maxChars (up to ${TOOLS_EXTRACT_MAX_CHARS_LIMIT.toLocaleString('en-US')}) for the rest ...]`
}

async function firecrawlScrape(
  key: string, url: string, format: ExtractFormat, signal: AbortSignal, correlationId: string | undefined,
): Promise<string> {
  const response = await fetch(FIRECRAWL_SCRAPE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${key}`,
      ...(correlationId !== undefined ? { 'X-Correlation-Id': correlationId } : {}),
    },
    body: JSON.stringify({ url, formats: [format] }),
    signal,
  })
  if (!response.ok) throw new Error(`firecrawl HTTP ${response.status}`)
  const payload: unknown = await response.json()
  if (typeof payload !== 'object' || payload === null) throw new Error('firecrawl payload is not an object')
  const data = (payload as Record<string, unknown>)['data']
  const content = typeof data === 'object' && data !== null ? (data as Record<string, unknown>)[format] : undefined
  if (typeof content !== 'string' || content.trim() === '') throw new Error('firecrawl payload has no page content')
  return content
}

async function jinaRead(
  key: string, url: string, format: ExtractFormat, signal: AbortSignal, correlationId: string | undefined,
): Promise<string> {
  // The reader takes the target URL as the path (never encoded — the scheme
  // and host are part of the route); the body IS the extracted page.
  const response = await fetch(JINA_READER_BASE + url, {
    method: 'GET',
    headers: {
      Accept: 'text/plain',
      Authorization: `Bearer ${key}`,
      'X-Return-Format': format,
      ...(correlationId !== undefined ? { 'X-Correlation-Id': correlationId } : {}),
    },
    signal,
  })
  if (!response.ok) throw new Error(`jina HTTP ${response.status}`)
  const content = await response.text()
  if (content.trim() === '') throw new Error('jina returned an empty body')
  return content
}

/** One vendor call within the 20s cap; the inbound request's abort signal is
 * honoured alongside it so a client disconnect still cancels the vendor hop. */
async function runVendorExtract(
  provider: 'firecrawl' | 'jina', key: string, url: string, format: ExtractFormat,
  signal: AbortSignal, correlationId: string | undefined,
): Promise<string> {
  const timeoutSignal = AbortSignal.any([signal, AbortSignal.timeout(TOOLS_EXTRACT_VENDOR_TIMEOUT_MS)])
  return provider === 'firecrawl'
    ? firecrawlScrape(key, url, format, timeoutSignal, correlationId)
    : jinaRead(key, url, format, timeoutSignal, correlationId)
}

interface ExtractRequest {
  url: string
  format: ExtractFormat
  maxChars: number
  provider?: string
}

/** Body validation lives here so the handler stays a straight-line pipeline. */
function parseExtractRequest(raw: Record<string, unknown>): ExtractRequest {
  const url = typeof raw['url'] === 'string' ? raw['url'].trim() : ''
  if (url === '' || url.length > 2_048) {
    throw new HttpApiError(400, 'validation_failed', 'url is required (http(s) URL, max 2048 chars)')
  }
  let target: URL
  try {
    target = new URL(url)
  } catch {
    throw new HttpApiError(400, 'validation_failed', 'url must be a valid http(s) URL')
  }
  if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.username || target.password) {
    throw new HttpApiError(400, 'validation_failed', 'url must be a valid http(s) URL')
  }
  const requestedFormat = raw['format'] === undefined ? 'markdown' : raw['format']
  if (requestedFormat !== 'markdown' && requestedFormat !== 'html') {
    throw new HttpApiError(400, 'validation_failed', "format must be 'markdown' or 'html'")
  }
  let maxChars = TOOLS_EXTRACT_MAX_CHARS_DEFAULT
  if (raw['maxChars'] !== undefined) {
    const value = raw['maxChars']
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > TOOLS_EXTRACT_MAX_CHARS_LIMIT) {
      throw new HttpApiError(400, 'validation_failed', `maxChars must be an integer 1..${TOOLS_EXTRACT_MAX_CHARS_LIMIT}`)
    }
    maxChars = value
  }
  const provider = typeof raw['provider'] === 'string' && raw['provider'].trim() !== '' ? raw['provider'].trim() : undefined
  return { url, format: requestedFormat as ExtractFormat, maxChars, ...(provider !== undefined ? { provider } : {}) }
}

export function createExtractRoutes(deps: ToolsExtractRoutesDeps): Hono<AppEnv> {
  const { config, redis, logger } = deps
  // Boot-validated like the search catalog: a malformed TOOLS_EXTRACT_CATALOG
  // aborts startup instead of surfacing per-request 500s.
  const catalog = parseToolsExtractCatalog(config.TOOLS_EXTRACT_CATALOG)

  const routes = new Hono<AppEnv>()

  routes.post('/extract', async (c) => {
    const auth = requireAuthContext(c)
    // 服务主体是服务器到服务器调用（hermes 的 account-backend 会话同样自带
    // 匹配的 Origin），浏览器会话则沿用媒体树的同源约束。
    if (!isServicePrincipal(auth)) assertSameOrigin(c, new URL(config.BETTER_AUTH_URL).origin)

    const body = await c.req.json().catch(() => null)
    if (body === null) {
      throw new HttpApiError(400, 'invalid_json', 'Request body is not valid JSON.')
    }
    const request = parseExtractRequest(body as Record<string, unknown>)
    const { url, format, maxChars, provider } = request

    let resolved
    try {
      resolved = resolveExtractEntry(catalog, provider, config)
    } catch (error) {
      if (error instanceof ToolsCatalogError) {
        throw new HttpApiError(error.status, error.code, error.message)
      }
      throw error
    }

    try {
      const content = await runVendorExtract(
        resolved.entry.provider, resolved.key, url, format, c.req.raw.signal, c.get('correlationId'),
      )
      // Server-side truncation: the marker is appended INSIDE the budget so the
      // returned content never exceeds maxChars (clients hand it straight to
      // models with their own budgets). A budget too small to hold the marker
      // drops it — the truncated flag still says what happened.
      const truncated = content.length > maxChars
      let bounded = content
      if (truncated) {
        const footer = truncationFooter(maxChars)
        const room = maxChars - footer.length
        bounded = room > 0 ? content.slice(0, room) + footer : content.slice(0, maxChars)
      }
      logger.info({ requestId: c.get('requestId'), userId: auth.userId, provider: resolved.entry.id, format, chars: bounded.length, truncated }, 'tools extract served')
      await recordToolsUsage(redis, auth.userId, resolved.entry.id)
      return c.json({ ok: true, url, format, content: bounded, truncated })
    } catch (error) {
      if (error instanceof HttpApiError) throw error
      logger.warn({ requestId: c.get('requestId'), provider: resolved.entry.id, err: error }, 'tools extract vendor call failed')
      throw new HttpApiError(502, 'internal_error', 'Web extraction failed.')
    }
  })

  return routes
}
