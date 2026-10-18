import { Hono } from 'hono'
import type { StatusCode } from 'hono/utils/http-status'
import type { AppConfig } from '../../config/env.js'
import type { AppEnv } from '../../shared/context.js'
import { isServicePrincipal, requireAuthContext } from '../../shared/context.js'
import { HttpApiError } from '../../shared/http.js'
import type { Logger } from '../../shared/logger.js'

/**
 * ALL /api/media/fal-queue/* — authenticated forward proxy for the fal queue
 * API (ai-drama 的创作工具链：提交 / status / result 轮询)。The fal key stays
 * here: callers present the internal service token and this process rewrites
 * the hop to `https://queue.fal.run/<path>` with `Authorization: Key …`.
 * Result assets live on vendor CDNs (fal.media, storage.googleapis.com) and
 * carry no credential — those downloads stay with the caller.
 */

const QUEUE_BASE = 'https://queue.fal.run'

/** Queue paths are `/​<owner>/<model>[/<request-id>|/requests/<id>[/status|/logs]]`:
 * two-plus segments of safe URL characters with no dot-only segment, so the
 * proxy can never be walked onto another host or path. */
const QUEUE_PATH = /^(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_.-]+)+$/

export function createFalQueueProxyRoutes(deps: { config: AppConfig; logger: Logger }): Hono<AppEnv> {
  const { config, logger } = deps

  const routes = new Hono<AppEnv>()

  routes.all('/*', async (c) => {
    const auth = requireAuthContext(c)
    if (!isServicePrincipal(auth)) {
      throw new HttpApiError(403, 'forbidden', 'The queue proxy serves internal services only.')
    }

    const subpath = c.req.path.replace(/^\/api\/media\/fal-queue\//, '')
    if (!QUEUE_PATH.test(subpath)) {
      throw new HttpApiError(404, 'not_found', 'Unknown queue path.')
    }

    const body = c.req.method === 'GET' || c.req.method === 'HEAD' ? undefined : JSON.stringify(await c.req.json().catch(() => ({})))
    const upstream = await fetch(`${QUEUE_BASE}/${subpath}${c.req.url.includes('?') ? c.req.url.slice(c.req.url.indexOf('?')) : ''}`, {
      method: c.req.method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Accept: 'application/json',
        Authorization: `Key ${config.FAL_KEY}`,
      },
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(config.MEDIA_REQUEST_TIMEOUT_MS),
    })

    const text = await upstream.text()
    logger.info({ requestId: c.get('requestId'), userId: auth.userId, path: subpath, status: upstream.status }, 'fal queue proxied')
    return c.newResponse(text, upstream.status as StatusCode, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    })
  })

  return routes
}
