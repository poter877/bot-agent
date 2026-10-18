import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { STORAGE_ROOT } from '../utils/paths.js'
import { CreativeError, revisionSchema } from '../services/creative-model.js'
import { requireCreativeRevision, saveCreativeProject, withCreativeMutation } from '../services/creative-projects.js'
import { inspectCreativeSource } from '../services/creative-renderer.js'
import { saveUploadedFile } from '../utils/storage.js'
import { success } from '../utils/response.js'
import { parseCreativeSrt, sourceSelectionSchema, sourceSelectionsToShots } from '../services/creative-sources.js'
import { transcribeCreativeSource } from '../services/creative-speech.js'
export const creativeSourceRoutes = new Hono()
creativeSourceRoutes.post('/:id/sources/:sourceId/transcribe',async c=>{
  const {revision}=z.object({revision:revisionSchema}).strict().parse(await c.req.json())
  return success(c,await transcribeCreativeSource(Number(c.req.param('id')),revision,z.string().uuid().parse(c.req.param('sourceId'))))
})
creativeSourceRoutes.post('/:id/sources/upload', bodyLimit({ maxSize: 513 * 1024 * 1024, onError: c => c.json({code:413,message:'素材不能超过 512MB'},413) }), async c => {
  const id = Number(c.req.param('id')), revision = revisionSchema.parse(Number(c.req.query('revision')))
  requireCreativeRevision(id, revision)
  const body = await c.req.parseBody(), file = body.file
  if (!(file instanceof File) || !file.size || file.size > 512 * 1024 * 1024 || !/\.(mp4|mov|webm|m4v|mp3|wav|m4a|aac|png|jpe?g|webp)$/i.test(file.name)) throw new CreativeError('请选择不超过 512MB 的视频、音频或图片文件')
  const url = '/' + await saveUploadedFile(await file.arrayBuffer(), 'uploads', file.name)
  let coverUrl: string | null = null
  try {
  const info = await inspectCreativeSource(id, url)
  coverUrl = info.coverUrl
  const source = { id: randomUUID(), name: file.name.slice(0,200), url, ...info, transcript: '', attribution: '' }
  return success(c, await withCreativeMutation(id, () => {
    const project = requireCreativeRevision(id, revision)
    return saveCreativeProject(id, { ...project, production: { ...project.production, sources: [...project.production.sources, source] } }, source)
  }))
  } catch (error) {
    // Only remove fresh uploads and their derived cover, never pre-existing media.
    await Promise.allSettled([url, coverUrl].filter((value): value is string => !!value && value !== null).map(value => fs.rm(path.join(STORAGE_ROOT, value.slice('/static/'.length)), { force: true })))
    throw error
  }
})
creativeSourceRoutes.post('/:id/sources/arrange', async c => {
  const id = Number(c.req.param('id'))
  const input = z.object({ revision: revisionSchema, sourceId: z.string().uuid(), selections: z.array(sourceSelectionSchema).max(200).default([]), srt: z.string().max(100000).optional(), replace: z.boolean().default(false) }).parse(await c.req.json())
  return success(c, await withCreativeMutation(id, () => {
    const project = requireCreativeRevision(id, input.revision)
    const ranges = input.srt ? parseCreativeSrt(input.srt) : input.selections
    const shots = sourceSelectionsToShots(project, input.sourceId, ranges, !!input.srt)
    return saveCreativeProject(id, { ...project, shots: input.replace ? shots : [...project.shots, ...shots] })
  }))
})
