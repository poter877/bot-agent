import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../shared/context.js'
import { requireAuthContext } from '../../shared/context.js'
import { HttpApiError } from '../../shared/http.js'
import { cloudActionSchema } from './protocol.js'
import { cloudSnapshot, type CloudComputerService } from './service.js'

const authoritySchema = z.object({
  actor: z.enum(['agent', 'human']), computerGeneration: z.number().int().min(0), leaseEpoch: z.number().int().min(0),
  viewerToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict()
const tokenSchema = z.object({ viewerToken: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const inputSchema = z.object({ ...authoritySchema.shape, action: z.string(), params: z.record(z.string(), z.unknown()) }).strict()

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new HttpApiError(400, 'validation_failed', 'Invalid cloud computer request.')
  return result.data
}

export function createCloudComputerRoutes(service: CloudComputerService | null, origin: string): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store')
    if (c.req.method !== 'GET' && c.req.header('origin') !== origin) throw new HttpApiError(403, 'forbidden', 'Origin does not match the backend.')
    await next()
  })
  const available = () => {
    if (!service) throw new HttpApiError(503, 'dependency_unavailable', 'Cloud computers are not configured on this server.')
    return service
  }
  routes.get('/status', async (c) => c.json(service ? await service.status(requireAuthContext(c)) : cloudSnapshot(undefined, false)))
  for (const [path, desired] of [['/start', 'running'], ['/stop', 'stopped']] as const) {
    routes.post(path, async (c) => {
      parse(z.object({}).strict(), await c.req.json())
      return c.json(await available().desired(requireAuthContext(c), desired))
    })
  }
  routes.post('/capture', async (c) => c.json(await available().capture(requireAuthContext(c), parse(authoritySchema, await c.req.json()))))
  routes.post('/actions', async (c) => {
    const input = parse(inputSchema, await c.req.json())
    const { action, params, ...authority } = input
    return c.json(await available().action(requireAuthContext(c), authority, parse(cloudActionSchema, { action, params })))
  })
  routes.post('/lease/acquire', async (c) => {
    parse(z.object({}).strict(), await c.req.json())
    return c.json(await available().acquire(requireAuthContext(c)))
  })
  for (const [path, release] of [['/lease/release', true], ['/lease/renew', false]] as const) {
    routes.post(path, async (c) => {
      const body = parse(tokenSchema, await c.req.json())
      return c.json(await available().control(requireAuthContext(c), body.viewerToken, release))
    })
  }
  return routes
}
