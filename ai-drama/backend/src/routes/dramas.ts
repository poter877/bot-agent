import { Hono } from 'hono'
import { and, eq, isNull, like, desc } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, badRequest, notFound, created, now } from '../utils/response.js'
import { toSnakeCase, toSnakeCaseArray } from '../utils/transform.js'
import { z } from 'zod'
import { aspectRatioSchema, creativeCategorySchema, createCreativeDocument } from '../services/creative-model.js'
import { createFilmProject } from '../services/film-pipeline/runs.js'

const app = new Hono()

// GET /dramas - List dramas
app.get('/', async (c) => {
  const page = Number(c.req.query('page') || 1)
  const pageSize = Number(c.req.query('page_size') || 20)
  const status = c.req.query('status')
  const keyword = c.req.query('keyword')

  const allRows = await db.select().from(schema.dramas)
    .where(isNull(schema.dramas.deletedAt))
    .orderBy(desc(schema.dramas.updatedAt))
  let filtered = allRows

  if (status) filtered = filtered.filter(d => d.status === status)
  if (keyword) filtered = filtered.filter(d => d.title.includes(keyword))

  const total = filtered.length
  const items = filtered.slice((page - 1) * pageSize, page * pageSize)

  // Attach episode/character/scene counts
  const enriched = await Promise.all(items.map(async (drama) => {
    const eps = await db.select().from(schema.episodes)
      .where(and(eq(schema.episodes.dramaId, drama.id), isNull(schema.episodes.deletedAt)))
    const chars = await db.select().from(schema.characters)
      .where(eq(schema.characters.dramaId, drama.id))
    const scns = await db.select().from(schema.scenes)
      .where(eq(schema.scenes.dramaId, drama.id))
    return {
      ...toSnakeCase(drama),
      tags: drama.tags ? JSON.parse(drama.tags) : [],
      total_episodes: eps.length,
      episodes: toSnakeCaseArray(eps),
      characters: toSnakeCaseArray(chars),
      scenes: toSnakeCaseArray(scns),
    }
  }))

  return success(c, {
    items: enriched,
    pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) },
  })
})

// POST /dramas - Create drama
app.post('/', async (c) => {
  const body = await c.req.json()
  const parsed = z.object({
    title: z.string().trim().min(1).max(200),
    project_type: z.enum(['drama', 'creative', 'film']).default('drama'),
    creative_category: creativeCategorySchema.nullish(),
    film_style: z.string().trim().max(60).nullish(),
    aspect_ratio: aspectRatioSchema.default('16:9'),
    style: z.string().max(100).optional(),
  }).safeParse(body)
  if (!parsed.success) return badRequest(c, parsed.error.issues.map(issue => issue.message).join('；'))
  if (parsed.data.project_type === 'creative' && !parsed.data.creative_category) return badRequest(c, '请选择创意视频用途')
  if (parsed.data.project_type === 'drama' && parsed.data.creative_category) return badRequest(c, '短剧项目不能设置创意视频用途')
  if (parsed.data.project_type === 'film' && !parsed.data.film_style) return badRequest(c, '请选择影片风格')
  if (parsed.data.project_type !== 'film' && parsed.data.film_style) return badRequest(c, '只有影片风格项目能设置 film_style')
  const ts = now()
  const result = db.transaction((tx) => {
    const res = tx.insert(schema.dramas).values({
      title: parsed.data.title,
      projectType: parsed.data.project_type,
      creativeCategory: parsed.data.creative_category || null,
      filmStyle: parsed.data.film_style || null,
      description: body.description,
      genre: body.genre,
      style: parsed.data.style,
      aspectRatio: parsed.data.aspect_ratio,
      tags: body.tags ? JSON.stringify(body.tags) : null,
      metadata: body.metadata,
      status: 'draft',
      createdAt: ts,
      updatedAt: ts,
    }).run()
    const id = getInsertId(res)
    if (parsed.data.project_type === 'creative') tx.insert(schema.creativeProjects).values({
      projectId: id, document: JSON.stringify(createCreativeDocument(parsed.data.creative_category!)), revision: 1, updatedAt: ts,
    }).run()
    if (parsed.data.project_type === 'film') {
      createFilmProject({
        projectId: id,
        styleSlug: parsed.data.film_style!,
        topic: typeof body.topic === 'string' ? body.topic : '',
        language: typeof body.language === 'string' && body.language ? body.language : 'zh',
        durationSec: Number.isFinite(Number(body.duration_sec)) && Number(body.duration_sec) > 0 ? Math.round(Number(body.duration_sec)) : 45,
        hasVoice: body.has_voice !== false,
      })
    }
    return tx.select().from(schema.dramas).where(eq(schema.dramas.id, id)).get()!
  })

  // 不再预建集 — 用户通过「添加集」流程创建（该流程会锁定图片/视频生成配置）
  return created(c, toSnakeCase(result))
})


// GET /dramas/stats — must be before /:id
app.get('/stats', async (c) => {
  const all = await db.select().from(schema.dramas).where(isNull(schema.dramas.deletedAt))
  const byStatus = Object.entries(
    all.reduce((acc, d) => {
      acc[d.status || 'draft'] = (acc[d.status || 'draft'] || 0) + 1
      return acc
    }, {} as Record<string, number>)
  ).map(([status, count]) => ({ status, count }))
  return success(c, { total: all.length, by_status: byStatus })
})

// GET /dramas/:id - Get drama detail
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, id))
  if (!drama || drama.deletedAt) return notFound(c, '剧本不存在')

  const eps = await db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.dramaId, id), isNull(schema.episodes.deletedAt)))
  const chars = await db.select().from(schema.characters)
    .where(eq(schema.characters.dramaId, id))
  const scns = await db.select().from(schema.scenes)
    .where(eq(schema.scenes.dramaId, id))
  const prps = await db.select().from(schema.props)
    .where(eq(schema.props.dramaId, id))

  return success(c, {
    ...toSnakeCase(drama),
    tags: drama.tags ? JSON.parse(drama.tags) : [],
    episodes: toSnakeCaseArray(eps),
    characters: toSnakeCaseArray(chars),
    scenes: toSnakeCaseArray(scns),
    props: toSnakeCaseArray(prps),
  })
})

// PUT /dramas/:id - Update drama
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const project = db.select().from(schema.dramas).where(eq(schema.dramas.id, id)).get()
  if (!project || project.deletedAt) return notFound(c, '项目不存在')
  if (project.projectType === 'creative') {
    if (Object.keys(body).length !== 1 || !['draft', 'active', 'in_progress', 'completed', 'archived'].includes(body.status)) {
      return badRequest(c, '请在创意视频工作台保存项目，避免覆盖未确认的方案')
    }
    await db.update(schema.dramas).set({ status: body.status, updatedAt: now() }).where(eq(schema.dramas.id, id))
    return success(c)
  }
  if (body.project_type !== undefined || body.creative_category !== undefined) return badRequest(c, '创建后不能更改项目类型')
  const updates: Record<string, any> = { updatedAt: now() }
  if (body.title !== undefined) updates.title = body.title
  if (body.description !== undefined) updates.description = body.description
  if (body.genre !== undefined) updates.genre = body.genre
  if (body.style !== undefined) updates.style = body.style
  if (body.aspect_ratio !== undefined) updates.aspectRatio = body.aspect_ratio
  if (body.status !== undefined) updates.status = body.status
  if (body.tags !== undefined) updates.tags = JSON.stringify(body.tags)
  if (body.metadata !== undefined) updates.metadata = body.metadata
  await db.update(schema.dramas).set(updates).where(eq(schema.dramas.id, id))
  return success(c)
})

// DELETE /dramas/:id - Soft delete
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.update(schema.dramas).set({ deletedAt: now() }).where(eq(schema.dramas.id, id))
  return success(c)
})

// PUT /dramas/:id/characters - Save characters
app.put('/:id/characters', async (c) => {
  const dramaId = Number(c.req.param('id'))
  const body = await c.req.json()
  const chars = body.characters || []
  const ts = now()

  for (const char of chars) {
    if (char.id) {
      await db.update(schema.characters).set({ ...char, updatedAt: ts }).where(eq(schema.characters.id, char.id))
    } else {
      await db.insert(schema.characters).values({ ...char, dramaId, createdAt: ts, updatedAt: ts })
    }
  }
  return success(c)
})

// PUT /dramas/:id/episodes - Save episodes
app.put('/:id/episodes', async (c) => {
  const dramaId = Number(c.req.param('id'))
  const project = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).get()
  if (!project || project.deletedAt) return notFound(c, '项目不存在')
  if (project.projectType === 'creative') return badRequest(c, '创意视频项目不使用剧集，请进入创意视频工作台')
  const body = await c.req.json()
  const episodes = body.episodes || []
  const ts = now()

  for (const ep of episodes) {
    if (ep.id) {
      await db.update(schema.episodes).set({ ...ep, updatedAt: ts }).where(eq(schema.episodes.id, ep.id))
    } else {
      await db.insert(schema.episodes).values({
        ...ep,
        dramaId,
        episodeNumber: ep.episode_number || ep.episodeNumber || 1,
        title: ep.title || '未命名',
        createdAt: ts,
        updatedAt: ts,
      })
    }
  }
  return success(c)
})

export default app
