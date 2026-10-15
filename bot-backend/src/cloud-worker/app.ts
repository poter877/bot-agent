import { createHash, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { cloudActionSchema, type CloudWorker } from '../modules/cloud-computer/protocol.js'
import type { WorkerConfig } from './config.js'
import { diagnostic, writeDiagnostic, type DiagnosticSink } from './diagnostics.js'
import { WorkerError } from './errors.js'

export function createWorkerApp(config: WorkerConfig, worker: CloudWorker, diagnostics: DiagnosticSink = writeDiagnostic): Hono {
  const app = new Hono()
  const tokenDigest = createHash('sha256').update(config.CLOUD_WORKER_TOKEN).digest()
  app.use('*', async (c, next) => {
    const presented = c.req.header('authorization') ?? ''
    const actual = createHash('sha256').update(presented.startsWith('Bearer ') ? presented.slice(7) : '').digest()
    if (!timingSafeEqual(tokenDigest, actual)) throw new WorkerError(401, 'unauthorized', 'Worker authentication required.')
    c.header('Cache-Control', 'no-store')
    await next()
  })
  app.use('*', bodyLimit({ maxSize: 64 * 1024 }))
  app.onError((error, c) => {
    diagnostics(diagnostic(error, c))
    if (error instanceof WorkerError) return c.json({ error: { code: error.code, message: error.message } }, error.status)
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return c.json({ error: { code: 'invalid_request', message: 'Invalid cloud computer request.' } }, 400)
    }
    return c.json({ error: { code: 'runtime_unavailable', message: 'Cloud computer runtime unavailable. Please retry.' } }, 503)
  })
  app.get('/healthz', (c) => c.json({ ok: true }))
  const identity = (owner: string | undefined, id: string) => {
    if (!owner || owner.length > 256 || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
      throw new WorkerError(400, 'invalid_identity', 'A valid owner and computer ID are required.')
    }
    return [owner, id] as const
  }
  app.get('/v1/computers/:id', async (c) => c.json(await worker.status(...identity(c.req.header('X-Cloud-Owner'), c.req.param('id')))))
  app.post('/v1/computers/:id/start', async (c) => c.json(await worker.start(...identity(c.req.header('X-Cloud-Owner'), c.req.param('id')))))
  app.post('/v1/computers/:id/stop', async (c) => c.json(await worker.stop(...identity(c.req.header('X-Cloud-Owner'), c.req.param('id')))))
  app.post('/v1/computers/:id/capture', async (c) => c.json(await worker.capture(...identity(c.req.header('X-Cloud-Owner'), c.req.param('id')))))
  app.post('/v1/computers/:id/actions', async (c) => {
    const [owner, id] = identity(c.req.header('X-Cloud-Owner'), c.req.param('id'))
    const action = cloudActionSchema.parse(await c.req.json())
    return c.json(await worker.action(owner, id, action))
  })
  return app
}
