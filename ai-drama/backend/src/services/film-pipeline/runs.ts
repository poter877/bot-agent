/** film-pipeline 运行服务：项目 CRUD、run 状态机、阶段执行与推进。
 *
 * 状态机（简化自 creative-pipeline runner，语义对齐影片流程）：
 *   running →（review 阶段）review --approve→ running
 *          →（render 阶段）waiting（作业轮询）→ running
 *          → 全部完成 completed；失败 failed --retry→ running（当前阶段重跑）
 * 持久化：film_runs（stages JSON 快照）；重启后由 recoverFilmRuns 恢复推进。
 */
import fs from 'node:fs'
import path from 'node:path'
import { db, schema, getInsertId } from '../../db/index.js'
import { eq } from 'drizzle-orm'
import { STORAGE_ROOT } from '../../utils/paths.js'
import { getFilmStyle, filmStyleMarkdown, type FilmStyle } from '../film-styles.js'
import { FilmError, type FilmArtifact, type FilmRunView, type FilmStageState } from './contracts.js'
import { filmPipelineDefinition, type FilmPipelineDefinition } from './definitions.js'
import { generateFilmStageArtifact } from './text.js'
import { runBuildAgent, readFilmAgentLog } from './build-agent.js'
import { filmProjectDir, latestFilmRender, startFilmRender } from './render.js'

export function now() {
  return new Date().toISOString()
}

const DEFINITION = filmPipelineDefinition()

export interface FilmProjectView {
  projectId: number
  title: string
  style: FilmStyle
  topic: string
  language: string
  durationSec: number
  hasVoice: boolean
  aspectRatio: string
  revision: number
  run: FilmRunView | null
  render: ReturnType<typeof latestFilmRender>
}

export function createFilmProject(input: {
  projectId: number
  styleSlug: string
  topic: string
  language: string
  durationSec: number
  hasVoice: boolean
}) {
  const style = getFilmStyle(input.styleSlug)
  if (!style) throw new FilmError(`未知影片风格：${input.styleSlug}`, 404)
  const ts = now()
  getInsertId(
    db
      .insert(schema.filmProjects)
      .values({
        projectId: input.projectId,
        styleSlug: input.styleSlug,
        topic: input.topic,
        language: input.language,
        durationSec: input.durationSec,
        hasVoice: input.hasVoice ? 1 : 0,
        revision: 1,
        updatedAt: ts,
      })
      .run(),
  )
  fs.mkdirSync(filmProjectDir(input.projectId), { recursive: true })
  return getFilmProject(input.projectId)
}

function filmProjectRow(projectId: number) {
  return db.select().from(schema.filmProjects).where(eq(schema.filmProjects.projectId, projectId)).get()
}

function dramaRow(projectId: number) {
  return db.select().from(schema.dramas).where(eq(schema.dramas.id, projectId)).get()
}

function runRow(projectId: number) {
  const rows = db.select().from(schema.filmRuns).where(eq(schema.filmRuns.projectId, projectId)).all()
  return rows.length ? rows[rows.length - 1]! : null
}

function toRunView(row: typeof schema.filmRuns.$inferSelect): FilmRunView {
  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status as FilmRunView['status'],
    cursor: row.cursor,
    stages: JSON.parse(row.stages) as FilmStageState[],
    error: row.error,
  }
}

export function getFilmProject(projectId: number): FilmProjectView {
  const row = filmProjectRow(projectId)
  if (!row) throw new FilmError('影片项目不存在', 404)
  const drama = dramaRow(projectId)
  if (!drama) throw new FilmError('项目不存在', 404)
  const style = getFilmStyle(row.styleSlug)!
  const run = runRow(projectId)
  return {
    projectId,
    title: drama.title,
    style,
    topic: row.topic,
    language: row.language,
    durationSec: row.durationSec,
    hasVoice: !!row.hasVoice,
    aspectRatio: drama.aspectRatio || '16:9',
    revision: row.revision,
    run: run ? toRunView(run) : null,
    render: latestFilmRender(projectId),
  }
}

function freshStages(): FilmStageState[] {
  return DEFINITION.stages.map((s) => ({
    id: s.id,
    status: 'pending',
    attempt: 0,
    artifact: null,
    error: null,
    approvedAt: null,
    completedAt: null,
  }))
}

function saveRun(row: typeof schema.filmRuns.$inferSelect, patch: Partial<typeof schema.filmRuns.$inferInsert>) {
  db.update(schema.filmRuns)
    .set({ ...patch, updatedAt: now() })
    .where(eq(schema.filmRuns.id, row.id))
    .run()
}

/** 启动（或继续）影片流水线 */
export function startFilmRun(projectId: number) {
  const project = filmProjectRow(projectId)
  if (!project) throw new FilmError('影片项目不存在', 404)
  let row = runRow(projectId)
  const ts = now()
  if (!row) {
    const res = db
      .insert(schema.filmRuns)
      .values({
        projectId,
        definition: JSON.stringify(DEFINITION),
        status: 'running',
        cursor: 0,
        stages: JSON.stringify(freshStages()),
        createdAt: ts,
        updatedAt: ts,
      })
      .run()
    row = db.select().from(schema.filmRuns).where(eq(schema.filmRuns.id, getInsertId(res))).get()!
  } else if (row.status === 'completed') {
    throw new FilmError('流水线已完成', 409)
  } else if (row.status !== 'paused') {
    throw new FilmError(`流水线当前状态为 ${row.status}，不能重复启动`, 409)
  }
  saveRun(row, { status: 'running', error: null })
  void advance(projectId)
  return getFilmProject(projectId)
}

/** 审批当前 review 阶段 */
export function approveFilmStage(projectId: number) {
  const row = requireRun(projectId)
  if (row.status !== 'review') throw new FilmError('当前没有等待确认的阶段', 409)
  const stages = JSON.parse(row.stages) as FilmStageState[]
  const stage = stages[row.cursor]!
  stage.approvedAt = now()
  saveRun(row, { status: 'running', stages: JSON.stringify(stages) })
  void advance(projectId)
  return getFilmProject(projectId)
}

/** 重试当前失败/任意阶段（review 阶段的重试=重新生成） */
export function retryFilmStage(projectId: number) {
  const row = requireRun(projectId)
  if (!['failed', 'review', 'waiting'].includes(row.status)) throw new FilmError('当前状态不能重试', 409)
  const stages = JSON.parse(row.stages) as FilmStageState[]
  const stage = stages[row.cursor]!
  stage.status = 'pending'
  stage.artifact = null
  stage.error = null
  saveRun(row, { status: 'running', stages: JSON.stringify(stages), error: null })
  void advance(projectId)
  return getFilmProject(projectId)
}

function requireRun(projectId: number) {
  const row = runRow(projectId)
  if (!row) throw new FilmError('流水线尚未启动', 404)
  return row
}

/** 推进器：执行当前阶段直到遇到 review/waiting/完成/失败 */
async function advance(projectId: number) {
  for (let guard = 0; guard < 24; guard++) {
    const row = runRow(projectId)
    if (!row || row.status !== 'running') return
    const stages = JSON.parse(row.stages) as FilmStageState[]
    const cursor = row.cursor
    if (cursor >= DEFINITION.stages.length) {
      saveRun(row, { status: 'completed' })
      return
    }
    const def = DEFINITION.stages[cursor]!
    const state = stages[cursor]!

    if (def.id === 'render') {
      // 渲染阶段：启动/复用作业 → waiting
      let job = latestFilmRender(projectId)
      if (!job || job.status === 'failed') {
        const jobId = startFilmRender(projectId, row.id)
        job = db.select().from(schema.filmRenderJobs).where(eq(schema.filmRenderJobs.id, jobId)).get()!
      }
      if (job.status === 'completed') {
        state.status = 'completed'
        state.artifact = {
          summary: `渲染完成（${job.progress}%）`,
          content: `成片：${job.videoUrl ?? ''}\n海报：${job.posterUrl ?? ''}`,
          checks: [],
          data: { videoUrl: job.videoUrl, posterUrl: job.posterUrl },
        }
        state.completedAt = now()
        saveRun(row, { stages: JSON.stringify(stages), cursor: cursor + 1 })
        continue
      }
      if (job.status === 'processing') {
        state.status = 'waiting'
        state.artifact = {
          summary: `正在渲染 ${job.progress}%（${job.phase ?? ''}）`,
          content: '逐帧渲染与合成进行中，进度由渲染作业回传。',
          checks: [],
          data: { renderJobId: job.id },
        }
        saveRun(row, { status: 'waiting', stages: JSON.stringify(stages) })
        return
      }
      throw new Error(job.errorMsg || '渲染作业异常')
    }

    // 文本/代码生成阶段
    state.status = 'running'
    state.attempt += 1
    saveRun(row, { stages: JSON.stringify(stages) })
    try {
      const project = getFilmProject(projectId)
      const accepted: Record<string, FilmArtifact | null> = {}
      for (let i = 0; i < cursor; i++) accepted[DEFINITION.stages[i]!.id] = stages[i]!.artifact

      // build 阶段：AI SDK Agent 循环（本地工具：写工程文件 + film-core 渲帧自检）
      if (def.id === 'build') {
        const build = await runBuildAgent({
          projectId,
          styleSlug: project.style.slug,
          styleMd: filmStyleMarkdown(project.style.slug),
          systemExtra: `画幅 ${project.aspectRatio}；时长目标 ${project.durationSec} 秒；语言 ${project.language}${project.hasVoice ? '（含配音）' : '（无配音）'}。`,
          topic: project.topic,
          language: project.language,
          durationSec: project.durationSec,
          aspectRatio: project.aspectRatio,
          acceptedContent: Object.entries(accepted)
            .filter(([, v]) => v)
            .map(([k, v]) => `## ${k}\n${v!.content.slice(0, 8000)}`)
            .join('\n\n'),
        })
        state.artifact = {
          summary: `影片工程完成（${build.files.length} 个文件）`,
          content: `已写入文件：\n${build.files.join('\n')}\n\n${build.summary}`,
          checks: ['index.html 暴露 DUR/render/READY 契约', '渲染一帧自检视觉是否符合 STYLE.md'],
          data: { files: build.files },
        }
        state.error = null
        state.status = 'review'
        state.completedAt = now()
        saveRun(row, { status: 'review', stages: JSON.stringify(stages) })
        return
      }

      const artifact = await generateFilmStageArtifact({
        stage: def,
        style: project.style,
        title: project.title,
        topic: project.topic,
        language: project.language,
        durationSec: project.durationSec,
        hasVoice: project.hasVoice,
        aspectRatio: project.aspectRatio,
        accepted,
      })
      state.artifact = artifact
      state.error = null

      if (def.review) {
        state.status = 'review'
        saveRun(row, { status: 'review', stages: JSON.stringify(stages) })
        return
      }
      state.status = 'completed'
      state.completedAt = now()
      saveRun(row, { stages: JSON.stringify(stages), cursor: cursor + 1 })
    } catch (e) {
      state.status = 'failed'
      state.error = (e as Error).message
      saveRun(row, { status: 'failed', stages: JSON.stringify(stages), error: (e as Error).message })
      return
    }
  }
}

export function pollFilmRun(projectId: number) {
  const row = runRow(projectId)
  if (!row || row.status !== 'waiting') return
  const stages = JSON.parse(row.stages) as FilmStageState[]
  const stage = stages[row.cursor]
  if (stage?.id === 'render') {
    const job = latestFilmRender(projectId)
    if (!job) return
    if (job.status === 'completed') {
      saveRun(row, { status: 'running' })
      void advance(projectId)
    } else if (job.status === 'failed') {
      stage.status = 'failed'
      stage.error = job.errorMsg
      saveRun(row, { status: 'failed', stages: JSON.stringify(stages), error: job.errorMsg })
    } else {
      stage.artifact = {
        summary: `正在渲染 ${job.progress}%（${job.phase ?? ''}）`,
        content: '逐帧渲染与合成进行中。',
        checks: [],
        data: { renderJobId: job.id },
      }
      saveRun(row, { stages: JSON.stringify(stages) })
    }
  }
}

/** 重启恢复：running 卡在文本阶段 → 允许重试；waiting → 由轮询续接 */
export function recoverFilmRuns() {
  const rows = db.select().from(schema.filmRuns).where(eq(schema.filmRuns.status, 'running')).all()
  for (const row of rows) {
    const stages = JSON.parse(row.stages) as FilmStageState[]
    const current = stages[row.cursor]
    if (current?.status === 'running') {
      current.status = 'pending'
      current.error = null
      db.update(schema.filmRuns)
        .set({ status: 'failed', error: '服务重启中断，请重试当前阶段', stages: JSON.stringify(stages), updatedAt: now() })
        .where(eq(schema.filmRuns.id, row.id))
        .run()
    }
  }
}

export function filmWorkdirListing(projectId: number) {
  const dir = filmProjectDir(projectId)
  const walk = (base: string, prefix = ''): string[] =>
    fs.existsSync(base)
      ? fs.readdirSync(base, { withFileTypes: true }).flatMap((e) => {
          const rel = prefix ? `${prefix}/${e.name}` : e.name
          return e.isDirectory() ? walk(path.join(base, e.name), rel) : [rel]
        })
      : []
  return walk(dir)
}
