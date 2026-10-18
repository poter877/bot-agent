import { publicCreativeRecipe } from './creative-catalog.js'
import fs from 'node:fs'
import path from 'node:path'
import { and, eq, desc, inArray, isNull } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { CreativeError, creativeDocumentSchema, creativeSaveSchema, shotFingerprint, type CreativeCategory, type CreativeDocument, type CreativeShot, creativeSourceSchema } from './creative-model.js'
import type { z } from 'zod'

const mutationLocks = new Map<number, Promise<unknown>>()
/** Serialize short mutations across requests; content revision remains the durable conflict boundary. */
export async function withCreativeMutation<T>(id: number, run: () => Promise<T> | T): Promise<T> {
  const previous = mutationLocks.get(id) ?? Promise.resolve()
  const pending = previous.catch(() => undefined).then(run)
  mutationLocks.set(id, pending)
  try { return await pending } finally { if (mutationLocks.get(id) === pending) mutationLocks.delete(id) }
}

function readProject(id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new CreativeError('项目 ID 不正确', 400)
  const project = db.select().from(schema.dramas).where(and(eq(schema.dramas.id, id), isNull(schema.dramas.deletedAt))).get()
  if (!project || project.projectType !== 'creative') throw new CreativeError('创意视频项目不存在', 404)
  const record = db.select().from(schema.creativeProjects).where(eq(schema.creativeProjects.projectId, id)).get()
  if (!record) throw new CreativeError('创意视频文档不存在', 404)
  return { project, record, document: creativeDocumentSchema.parse(JSON.parse(record.document)) }
}

export function publicCreativeMediaUrl(url: string) { return url.startsWith('/') ? url : `/${url}` }

function taskForShot(id: number, shot: CreativeShot, kind: 'image' | 'video', style: string, aspectRatio: string) {
  const link = db.select().from(schema.creativeShotTasks).where(and(
    eq(schema.creativeShotTasks.projectId, id), eq(schema.creativeShotTasks.shotId, shot.id), eq(schema.creativeShotTasks.kind, kind),
  )).get()
  if (!link || link.fingerprint !== shotFingerprint(shot, style, aspectRatio)) return null
  const task = db.select().from(schema.sysTask).where(and(eq(schema.sysTask.id, link.taskId), eq(schema.sysTask.dramaId, id), eq(schema.sysTask.type, kind))).get()
  if (!task) return null
  return { id: task.id, status: task.status || 'failed', errorMsg: task.errorMsg, localPath: task.localPath ? publicCreativeMediaUrl(task.localPath) : null }
}

export function getCreativeProject(id: number) {
  const { project, record, document } = readProject(id)
  const style = project.style || '3d'
  const aspectRatio = (project.aspectRatio || '16:9') as '16:9' | '9:16' | '1:1'
  const shots = document.shots.map(shot => {
    const imageTask = taskForShot(id, shot, 'image', style, aspectRatio)
    const videoTask = taskForShot(id, shot, 'video', style, aspectRatio)
    return {
      ...shot,
      // Job state never overwrites the saved creative document or increments its revision.
      imageUrl: shot.imageUrl ?? (imageTask?.status === 'completed' ? imageTask.localPath : null),
      videoUrl: shot.videoUrl ?? (videoTask?.status === 'completed' ? videoTask.localPath : null),
      imageTaskId: imageTask?.id ?? null, videoTaskId: videoTask?.id ?? null,
      ...(imageTask ? { imageTask } : {}), ...(videoTask ? { videoTask } : {}),
    }
  })
  const renders = db.select().from(schema.creativeRenders).where(eq(schema.creativeRenders.projectId, id))
    .orderBy(desc(schema.creativeRenders.id)).limit(50).all().map(render => ({
      id: render.id, status: render.status, progress: render.progress, videoUrl: render.videoUrl, subtitleUrl: render.subtitleUrl,
      duration: render.duration, errorMsg: render.errorMsg, warnings: JSON.parse(render.warnings) as string[],
      createdAt: render.createdAt, revision: render.revision, outputs: JSON.parse(render.outputs) as { shotId: string; title: string; videoUrl: string; subtitleUrl: string | null; duration: number }[],
    }))
  return {
    id, title: project.title, category: project.creativeCategory as CreativeCategory, recipe: publicCreativeRecipe(project.creativeCategory!), style, aspectRatio,
    revision: record.revision, approvedRevision: record.approvedRevision,
    brief: document.brief, plan: document.plan, production: document.production, audio: document.audio, shots, renders, updatedAt: record.updatedAt,
  }
}
export type CreativeProject = ReturnType<typeof getCreativeProject>

export function requireCreativeRevision(id: number, revision: number, approved = false) {
  const project = getCreativeProject(id)
  if (project.revision !== revision) throw new CreativeError('项目已被修改，请刷新后重试，当前草稿不会自动覆盖新版本', 409)
  if (approved && project.approvedRevision !== revision) throw new CreativeError('请先确认当前制作方案', 409)
  return project
}

/** Validate both path confinement and provenance before accepting media references. */
export function validateCreativeMedia(id: number, url: string | null, kind: 'image' | 'video' | 'audio') {
  if (!url) return
  const relative = url.replace(/^\//, '')
  if (!/^static\/[a-zA-Z0-9_/-]+\.[a-zA-Z0-9]+$/.test(relative) || relative.includes('..')) {
    throw new CreativeError('素材路径不正确，请重新上传')
  }
  const extensions = {
    image: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bin'],
    video: ['.mp4', '.mov', '.webm', '.m4v', '.bin'],
    audio: ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'],
  }
  if (!extensions[kind].includes(path.extname(relative).toLowerCase())) throw new CreativeError(`素材类型不正确：${kind}`)
  try {
    const root = fs.realpathSync(STORAGE_ROOT)
    const file = fs.realpathSync(path.join(STORAGE_ROOT, relative.slice('static/'.length)))
    if (!file.startsWith(`${root}${path.sep}`) || !fs.statSync(file).isFile()) throw new Error('outside media store')
  } catch { throw new CreativeError('素材文件不存在或不可读取，请重新上传') }
  if (relative.startsWith('static/uploads/')) return // Uploaded library media are intentionally reusable.
  if (relative.startsWith(`static/creative/${id}/`)) return
  const task = db.select().from(schema.sysTask).where(and(
    eq(schema.sysTask.dramaId, id), eq(schema.sysTask.localPath, relative), eq(schema.sysTask.type, kind), eq(schema.sysTask.status, 'completed'),
  )).get()
  if (!task) throw new CreativeError('只能使用当前项目生成的素材或已上传的素材')
}

export function saveCreativeProject(id: number, raw: z.input<typeof creativeSaveSchema>, newSource?: z.infer<typeof creativeSourceSchema>) {
  const input = creativeSaveSchema.parse(raw)
  const current = requireCreativeRevision(id, input.revision)
  if (raw.production === undefined) input.production = current.production
  if (hasRunningCreativeTask(id)) throw new CreativeError('素材仍在生成，请完成后再保存方案修改', 409)
  const old = readProject(id).document
  const replacedTaskSlots: { shotId: string; kind: 'image' | 'video' }[] = []
  for (const shot of input.shots) {
    const existing = current.shots.find(s => s.id === shot.id)
    for (const kind of ['image', 'video'] as const) {
      const sentTask = shot[`${kind}TaskId`]
      if (sentTask && sentTask !== existing?.[`${kind}TaskId`]) throw new CreativeError('生成任务不属于该项目镜头')
      validateCreativeMedia(id, shot[`${kind}Url`], kind)
      // Never let an old form snapshot persist task IDs or pin a generated result. Links remain server owned.
      shot[`${kind}TaskId`] = null
      const priorSaved = old.shots.find(s => s.id === shot.id)?.[`${kind}Url`] ?? null
      if (shot[`${kind}Url`] && shot[`${kind}Url`] === existing?.[`${kind}Task`]?.localPath && priorSaved !== shot[`${kind}Url`]) {
        shot[`${kind}Url`] = null
      } else if (shot[`${kind}Url`] && existing?.[`${kind}Task`] && shot[`${kind}Url`] !== existing[`${kind}Task`]?.localPath) {
        replacedTaskSlots.push({ shotId: shot.id, kind })
      }
    }
  }
  for (const shot of input.shots) validateCreativeMedia(id, shot.audioUrl ?? null, 'audio')
  const allowedSources = new Map(current.production.sources.map(source => [source.id, source]))
  if (newSource) allowedSources.set(newSource.id, creativeSourceSchema.parse(newSource))
  for (const source of input.production.sources) {
    const original = allowedSources.get(source.id)
    if (!original || original.url !== source.url || original.kind !== source.kind || original.duration !== source.duration || original.coverUrl !== source.coverUrl) {
      throw new CreativeError('请通过素材库上传来源，不能直接修改素材地址或时长')
    }
    validateCreativeMedia(id, source.url, source.kind)
  }
  validateCreativeMedia(id, input.audio.narrationUrl, 'audio')
  validateCreativeMedia(id, input.audio.musicUrl, 'audio')
  const document = creativeDocumentSchema.parse(input)
  const ts = now()
  db.transaction(tx => {
    const updated = tx.update(schema.creativeProjects).set({
      document: JSON.stringify(document), revision: input.revision + 1, approvedRevision: null, updatedAt: ts,
    }).where(and(eq(schema.creativeProjects.projectId, id), eq(schema.creativeProjects.revision, input.revision))).run()
    if (!updated.changes) throw new CreativeError('项目已被修改，请刷新后重试', 409)
    for (const slot of replacedTaskSlots) tx.delete(schema.creativeShotTasks).where(and(
      eq(schema.creativeShotTasks.projectId, id), eq(schema.creativeShotTasks.shotId, slot.shotId), eq(schema.creativeShotTasks.kind, slot.kind),
    )).run()
    tx.update(schema.dramas).set({ ...(input.title ? { title: input.title } : {}), updatedAt: ts, status: 'draft' }).where(eq(schema.dramas.id, id)).run()
  })
  return getCreativeProject(id)
}

export function approveCreativeProject(id: number, revision: number) {
  const project = requireCreativeRevision(id, revision)
  if (!project.shots.length) throw new CreativeError('请先添加镜头或生成制作方案')
  if (project.shots.some(shot => !shot.visualPrompt.trim() && !(shot.mediaType === 'image' ? shot.imageUrl : shot.videoUrl))) {
    throw new CreativeError('每个镜头需要画面描述或导入素材')
  }
  const res = db.update(schema.creativeProjects).set({ approvedRevision: revision }).where(and(eq(schema.creativeProjects.projectId, id), eq(schema.creativeProjects.revision, revision))).run()
  if (!res.changes) throw new CreativeError('项目已被修改，请刷新后重试', 409)
  return getCreativeProject(id)
}

export function linkCreativeShotTask(project: CreativeProject, shot: CreativeShot, kind: 'image' | 'video', taskId: number) {
  const task = db.select().from(schema.sysTask).where(and(eq(schema.sysTask.id, taskId), eq(schema.sysTask.dramaId, project.id), eq(schema.sysTask.type, kind))).get()
  if (!task) throw new CreativeError('生成任务所属项目不匹配')
  db.insert(schema.creativeShotTasks).values({ projectId: project.id, shotId: shot.id, kind,
    fingerprint: shotFingerprint(shot, project.style, project.aspectRatio), taskId,
  }).onConflictDoUpdate({ target: [schema.creativeShotTasks.projectId, schema.creativeShotTasks.shotId, schema.creativeShotTasks.kind],
    set: { taskId, fingerprint: shotFingerprint(shot, project.style, project.aspectRatio) },
  }).run()
  // A deliberate regeneration replaces that slot; other shots and manual alternatives stay untouched.
  const { document } = readProject(project.id)
  const savedShot = document.shots.find(s => s.id === shot.id)
  if (savedShot) {
    savedShot[`${kind}Url`] = null
    db.update(schema.creativeProjects).set({ document: JSON.stringify(document) }).where(eq(schema.creativeProjects.projectId, project.id)).run()
  }
}

export function hasRunningCreativeTask(id: number, shotId?: string, kind?: string) {
  const links = db.select().from(schema.creativeShotTasks).where(eq(schema.creativeShotTasks.projectId, id)).all()
    .filter(link => (!shotId || link.shotId === shotId) && (!kind || link.kind === kind))
  return links.some(link => {
    const task = db.select().from(schema.sysTask).where(and(eq(schema.sysTask.id, link.taskId), eq(schema.sysTask.dramaId, id))).get()
    return task && ['pending', 'processing'].includes(task.status || '')
  })
}

export function createCreativeRender(project: CreativeProject, snapshot: unknown) {
  const active = db.select().from(schema.creativeRenders).where(and(eq(schema.creativeRenders.projectId, project.id), inArray(schema.creativeRenders.status, ['pending', 'processing']))).get()
  if (active) return { id: active.id, created: false }
  const result = db.insert(schema.creativeRenders).values({ projectId: project.id, revision: project.revision,
    snapshot: JSON.stringify(snapshot), status: 'pending', createdAt: now(),
  }).run()
  return { id: getInsertId(result), created: true }
}

export function recoverCreativeRenders() {
  return db.update(schema.creativeRenders).set({ status: 'failed', errorMsg: '服务重启，导出已中断，请重新导出', completedAt: now() })
    .where(inArray(schema.creativeRenders.status, ['pending', 'processing'])).run().changes
}
