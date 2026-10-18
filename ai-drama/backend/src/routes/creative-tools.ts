import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { success } from '../utils/response.js'
import { CreativeError, revisionSchema } from '../services/creative-model.js'
import { getCreativeProject } from '../services/creative-projects.js'
import { publicToolSettings, providerSchema, saveToolSettings } from '../services/creative-tools/settings.js'
import {
  applyLipSync,
  creativeToolService,
  getToolJob,
  importStockCandidate,
  listCreativeModels,
  listToolJobs,
  toolInputSchema,
  toolKindSchema,
  uploadCreativeModel,
  type createToolService,
} from '../services/creative-tools/jobs.js'
export function createToolRoutes(service: ReturnType<typeof createToolService> = creativeToolService) {
  const app = new Hono()
  app.get('/tool-settings', (c) => success(c, publicToolSettings()))
  app.put('/tool-settings/:provider', async (c) =>
    success(c, saveToolSettings(providerSchema.parse(c.req.param('provider')), await c.req.json())),
  )
  app.get('/:id/tools', (c) => {
    const id = Number(c.req.param('id'))
    return success(c, { jobs: listToolJobs(id), models: listCreativeModels(id) })
  })
  app.post('/:id/tools', async (c) => {
    const body = z
      .object({
        revision: revisionSchema,
        kind: toolKindSchema,
        input: toolInputSchema,
        force: z.boolean().default(false),
      })
      .strict()
      .parse(await c.req.json())
    return success(
      c,
      await service.start(Number(c.req.param('id')), body.revision, body.kind, body.input, body.force),
    )
  })
  app.get('/:id/tools/:jobId', (c) =>
    success(c, getToolJob(Number(c.req.param('id')), Number(c.req.param('jobId')))),
  )
  app.post('/:id/tools/:jobId/resume', async (c) => {
    const { remoteId } = z
      .object({
        remoteId: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[a-zA-Z0-9_-]+$/)
          .optional(),
      })
      .strict()
      .parse(await c.req.json())
    return success(c, service.resume(Number(c.req.param('id')), Number(c.req.param('jobId')), remoteId))
  })
  app.post('/:id/tools/:jobId/apply', async (c) => {
    const { revision } = z
      .object({ revision: revisionSchema })
      .strict()
      .parse(await c.req.json())
    return success(c, await applyLipSync(Number(c.req.param('id')), Number(c.req.param('jobId')), revision))
  })
  app.post('/:id/tools/:jobId/import', async (c) => {
    const { revision, candidateId } = z
      .object({ revision: revisionSchema, candidateId: z.string().min(1).max(100) })
      .strict()
      .parse(await c.req.json())
    return success(
      c,
      await importStockCandidate(
        Number(c.req.param('id')),
        Number(c.req.param('jobId')),
        candidateId,
        revision,
      ),
    )
  })
  app.post(
    '/:id/models',
    bodyLimit({
      maxSize: 51 * 1024 * 1024,
      onError: (c) => c.json({ code: 413, message: 'GLB 模型不能超过50MB' }, 413),
    }),
    async (c) => {
      const id = Number(c.req.param('id'))
      getCreativeProject(id)
      const { file } = await c.req.parseBody()
      if (
        !(file instanceof File) ||
        !file.size ||
        file.size > 50 * 1024 * 1024 ||
        !file.name.toLowerCase().endsWith('.glb')
      )
        throw new CreativeError('请选择不超过50MB且内嵌纹理的 GLB 模型')
      return success(c, await uploadCreativeModel(id, file.name, Buffer.from(await file.arrayBuffer())))
    },
  )
  return app
}
