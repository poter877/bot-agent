import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { success } from '../utils/response.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { CreativeError } from '../services/creative-model.js'
import { getCreativeProject } from '../services/creative-projects.js'
import { inspectCreativeSource } from '../services/creative-renderer.js'
import { inspectGlb } from '../services/creative-tools/files.js'
import { toolboxCatalog } from '../services/production-tools/catalog.js'
import {
  toolboxService,
  listToolboxJobs,
  applyToolboxOutput,
  type createToolboxService,
} from '../services/production-tools/jobs.js'
export function createProductionToolRoutes(
  service: ReturnType<typeof createToolboxService> = toolboxService,
) {
  const app = new Hono()
  app.get('/toolbox/catalog', async (c) => success(c, await toolboxCatalog()))
  app.get('/:id/toolbox', (c) => success(c, listToolboxJobs(Number(c.req.param('id')))))
  app.post('/:id/toolbox', async (c) =>
    success(c, await service.start(Number(c.req.param('id')), await c.req.json())),
  )
  app.post('/:id/toolbox/:jobId/resume', async (c) => {
    const input = z
      .object({ remoteId: z.string().max(500).optional(), retrySubmission: z.boolean().default(false) })
      .strict()
      .parse(await c.req.json())
    return success(
      c,
      service.resume(
        Number(c.req.param('id')),
        Number(c.req.param('jobId')),
        input.remoteId,
        input.retrySubmission,
      ),
    )
  })
  app.post('/:id/toolbox/:jobId/cancel', (c) =>
    success(c, service.cancel(Number(c.req.param('id')), Number(c.req.param('jobId')))),
  )
  app.post('/:id/toolbox/:jobId/apply', async (c) =>
    success(
      c,
      await applyToolboxOutput(Number(c.req.param('id')), Number(c.req.param('jobId')), await c.req.json()),
    ),
  )
  app.post(
    '/:id/toolbox/upload',
    bodyLimit({
      maxSize: 65 * 1024 * 1024,
      onError: (c) => c.json({ code: 413, message: '工具输入文件不能超过64MB' }, 413),
    }),
    async (c) => {
      const projectId = Number(c.req.param('id'))
      getCreativeProject(projectId)
      const body = await c.req.parseBody(),
        file = body.file
      if (!(file instanceof File) || !file.size || file.size > 64 * 1024 * 1024)
        throw new CreativeError('请选择不超过64MB的工具输入文件')
      const ext = path.extname(file.name).toLowerCase(),
        media = /^\.(mp4|mov|webm|m4v|mp3|wav|m4a|aac|ogg|flac|png|jpe?g|webp|avif)$/.test(ext)
      if (!media && !['.glb', '.json', '.svg', '.srt', '.vtt', '.txt'].includes(ext))
        throw new CreativeError('支持图片、视频、音频、GLB、JSON、SVG、SRT、VTT或TXT')
      const bytes = Buffer.from(await file.arrayBuffer())
      if (ext === '.glb') inspectGlb(bytes)
      if (ext === '.json') {
        if (bytes.length > 2 * 1024 * 1024) throw new CreativeError('JSON输入不能超过2MB')
        let value: unknown
        try {
          value = JSON.parse(bytes.toString('utf8'))
        } catch {
          throw new CreativeError('JSON文件格式无效')
        }
        if (!value || typeof value !== 'object') throw new CreativeError('JSON输入须为对象或数组')
      }
      if (ext === '.svg') {
        const svg = bytes.toString('utf8')
        if (
          bytes.length > 2 * 1024 * 1024 ||
          !/<svg[\s>]/i.test(svg) ||
          /<!DOCTYPE|<!ENTITY|<script|<foreignObject|<iframe|<object|<embed|\bon\w+\s*=|(?:href|src)\s*=\s*["']\s*(?!#|data:image\/)[^"']+|url\(\s*(?!#)/i.test(
            svg,
          )
        )
          throw new CreativeError('SVG不能含脚本、外部资源或嵌入网页')
      }
      if (['.srt', '.vtt', '.txt'].includes(ext) && (bytes.length > 2 * 1024 * 1024 || bytes.includes(0)))
        throw new CreativeError('文本文件不能超过2MB或包含二进制内容')
      const root = await fs.realpath(STORAGE_ROOT),
        dir = path.join(root, 'creative', String(projectId), 'toolbox', 'uploads')
      await fs.mkdir(dir, { recursive: true })
      if (!(await fs.realpath(dir)).startsWith(root + path.sep)) throw new CreativeError('上传目录无效')
      const name = randomUUID() + ext,
        destination = path.join(dir, name),
        url = `/static/creative/${projectId}/toolbox/uploads/${name}`
      await fs.writeFile(destination, bytes, { flag: 'wx' })
      try {
        const kind = media
          ? (await inspectCreativeSource(projectId, url, false)).kind
          : ext === '.glb'
            ? 'model'
            : ['.srt', '.vtt'].includes(ext)
              ? 'subtitle'
              : 'data'
        return success(c, { url, name: file.name.slice(0, 200), kind })
      } catch (error) {
        await fs.rm(destination, { force: true })
        throw error
      }
    },
  )
  return app
}
