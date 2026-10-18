import { and, desc, eq, notInArray } from 'drizzle-orm'
import { db, getInsertId, schema } from '../../db/index.js'
import { now } from '../../utils/response.js'
import { CreativeError, creativeDocumentSchema } from '../creative-model.js'
import { approveCreativeProject, getCreativeProject } from '../creative-projects.js'
import { getPipelineDefinition, type PipelineDefinition } from './definitions.js'
import { createStageExecutor } from './executor.js'
import { reconcilePipelineToolRevision } from './tool-runtime.js'
import { toolboxService } from '../production-tools/jobs.js'
import type { PipelineToolRuntime } from './tool-contracts.js'
import {
  PipelineInputRequired,
  narrativeArtifactSchema,
  type PipelineArtifact,
  type RunStatus,
  type StageState,
  type StageContext,
  type StageResult,
} from './contracts.js'

type RunRow = typeof schema.creativePipelineRuns.$inferSelect
const snapshot = (project: ReturnType<typeof getCreativeProject>) =>
  JSON.stringify({ title: project.title, ...creativeDocumentSchema.parse(project) })
function decode(row: RunRow) {
  return {
    ...row,
    status: row.status as RunStatus,
    definition: JSON.parse(row.definition) as PipelineDefinition,
    stages: JSON.parse(row.stages) as StageState[],
    snapshot: undefined,
  }
}
function freshStage(id: StageState['id']): StageState {
  return {
    id,
    status: 'pending',
    attempt: 0,
    artifact: null,
    error: null,
    approvedAt: null,
    startedAt: null,
    completedAt: null,
  }
}
function readRun(projectId: number, runId: number) {
  getCreativeProject(projectId)
  const row = db
    .select()
    .from(schema.creativePipelineRuns)
    .where(
      and(eq(schema.creativePipelineRuns.projectId, projectId), eq(schema.creativePipelineRuns.id, runId)),
    )
    .get()
  if (!row) throw new CreativeError('制作流程不存在', 404)
  return row
}
function log(row: RunRow, kind: string, payload: unknown, stageId: string | null = null) {
  db.insert(schema.creativePipelineEvents)
    .values({ runId: row.id, stageId, kind, payload: JSON.stringify(payload), createdAt: now() })
    .run()
}
function patch(
  row: RunRow,
  changes: Partial<Omit<RunRow, 'id' | 'projectId' | 'version'>>,
  kind: string,
  payload: unknown,
  stageId: string | null = null,
) {
  db.transaction((tx) => {
    const result = tx
      .update(schema.creativePipelineRuns)
      .set({ ...changes, version: row.version + 1, updatedAt: now() })
      .where(
        and(eq(schema.creativePipelineRuns.id, row.id), eq(schema.creativePipelineRuns.version, row.version)),
      )
      .run()
    if (!result.changes) throw new CreativeError('流程状态已变化，请刷新后重试', 409)
    if (kind !== 'poll') log(row, kind, payload, stageId)
  })
}
function reconcileRowRevision(row: RunRow): RunRow {
  const project = getCreativeProject(row.projectId)
  if (project.revision === row.revision) return row
  const state = decode(row),
    entry = state.stages[row.cursor]
  const revision = reconcilePipelineToolRevision(row.projectId, row.revision, entry?.artifact ?? null)
  if (revision === null) return row
  patch(
    row,
    { revision, snapshot: snapshot(project), stages: JSON.stringify(state.stages) },
    'tool_writeback_recovered',
    { revision },
    entry?.id,
  )
  return readRun(row.projectId, row.id)
}
export function getPipelineState(projectId: number) {
  const project = getCreativeProject(projectId)
  const rows = db
    .select()
    .from(schema.creativePipelineRuns)
    .where(eq(schema.creativePipelineRuns.projectId, projectId))
    .orderBy(desc(schema.creativePipelineRuns.id))
    .limit(10)
    .all()
  const latest = rows[0] ? reconcileRowRevision(rows[0]) : undefined
  return {
    definition: getPipelineDefinition(project.category),
    run: latest ? { ...decode(latest), stale: latest.revision !== project.revision } : null,
    history: rows.map(({ id, status, createdAt, revision }) => ({ id, status, createdAt, revision })),
    events: latest
      ? db
          .select()
          .from(schema.creativePipelineEvents)
          .where(eq(schema.creativePipelineEvents.runId, latest.id))
          .orderBy(desc(schema.creativePipelineEvents.id))
          .limit(50)
          .all()
          .map(({ payload, ...event }) => ({ ...event, payload: JSON.parse(payload) }))
      : [],
  }
}
export function getPipelineRun(projectId: number, runId: number) {
  return decode(readRun(projectId, runId))
}
export type StageExecutor = (context: StageContext) => Promise<StageResult>

export function createPipelineRunner(execute: StageExecutor = createStageExecutor(), pollMs = 2000) {
  const workers = new Map<number, Promise<void>>()
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  function clearTimer(runId: number) {
    const timer = timers.get(runId)
    if (timer) clearTimeout(timer)
    timers.delete(runId)
  }
  function current(row: RunRow) {
    return readRun(row.projectId, row.id)
  }
  function schedule(row: RunRow) {
    clearTimer(row.id)
    const timer = setTimeout(() => {
      timers.delete(row.id)
      try {
        const fresh = current(row)
        if (fresh.status === 'waiting') launch(fresh, false, true)
      } catch {
        /* project may have been deleted */
      }
    }, pollMs)
    timer.unref?.()
    timers.set(row.id, timer)
  }
  function checkpoint(row: RunRow, index: number, artifact: PipelineArtifact, revision?: number) {
    const fresh = current(row),
      state = decode(fresh)
    const project = revision === undefined ? null : getCreativeProject(row.projectId)
    if (project && project.revision !== revision)
      throw new CreativeError('工具写回期间项目已修改，请同步后继续', 409)
    state.stages[index].artifact = artifact
    patch(
      fresh,
      {
        stages: JSON.stringify(state.stages),
        ...(project ? { revision: project.revision, snapshot: snapshot(project) } : {}),
      },
      'checkpoint',
      { artifact },
      state.stages[index].id,
    )
  }
  async function work(initial: RunRow, retry: boolean) {
    let row = current(initial)
    try {
      while (row.status === 'running') {
        const state = decode(row),
          project = getCreativeProject(row.projectId)
        if (project.revision !== row.revision) {
          const recovered = reconcilePipelineToolRevision(
            row.projectId,
            row.revision,
            state.stages[row.cursor]?.artifact ?? null,
          )
          if (recovered === null)
            throw new PipelineInputRequired('项目内容已修改，请先同步修改，后续阶段将重新检查。')
          patch(
            row,
            { revision: recovered, snapshot: snapshot(project), stages: JSON.stringify(state.stages) },
            'tool_writeback_recovered',
            { revision: recovered },
            state.stages[row.cursor]?.id,
          )
          row = current(row)
          continue
        }
        const stage = state.definition.stages[row.cursor],
          entry = state.stages[row.cursor]
        if (!stage || !entry) throw new Error('流程阶段记录无效')
        if (stage.requires.some((id) => !state.stages.some((s) => s.id === id && s.status === 'completed')))
          throw new Error('前序阶段尚未完成或确认')
        if (entry.status === 'review') {
          patch(row, { status: 'review' }, 'review_required', {}, stage.id)
          return
        }
        const polling = entry.status === 'waiting'
        if (!polling) {
          entry.attempt++
          entry.startedAt = now()
        }
        if (entry.attempt > 20)
          throw new PipelineInputRequired('该阶段已尝试20次，请检查输入或重新建立流程。')
        if (polling && entry.startedAt && Date.now() - Date.parse(entry.startedAt) > 2 * 60 * 60 * 1000)
          throw new Error('等待素材或合成超过两小时，请检查任务后重试')
        entry.status = 'running'
        entry.error = null
        patch(
          row,
          { stages: JSON.stringify(state.stages), error: null },
          polling ? 'poll' : 'stage_started',
          { attempt: entry.attempt },
          stage.id,
        )
        const accepted = Object.fromEntries(
          state.stages
            .slice(0, row.cursor)
            .filter((s) => s.status === 'completed' && s.artifact)
            .map((s) => [s.id, s.artifact!]),
        )
        const result = await execute({
          project,
          definition: state.definition,
          stage,
          artifacts: accepted,
          previous: entry.artifact,
          retry,
          checkpoint: (artifact, revision) => checkpoint(row, row.cursor, artifact, revision),
        })
        row = current(row)
        const latestProject = getCreativeProject(row.projectId)
        const revision = result.revision ?? project.revision
        if (latestProject.revision !== revision)
          throw new PipelineInputRequired('阶段执行期间项目发生了修改，请同步修改后重试。')
        const updated = decode(row),
          target = updated.stages[row.cursor]
        target.artifact = result.artifact
        target.error = null
        target.status = result.waiting ? 'waiting' : stage.review ? 'review' : 'completed'
        target.completedAt = result.waiting ? null : now()
        const cursor = target.status === 'completed' ? row.cursor + 1 : row.cursor
        let status: RunStatus = result.waiting
          ? 'waiting'
          : stage.review
            ? 'review'
            : cursor === updated.stages.length
              ? 'completed'
              : 'running'
        if (row.status === 'pausing' && status !== 'completed') status = 'paused'
        patch(
          row,
          {
            status,
            cursor,
            stages: JSON.stringify(updated.stages),
            revision,
            snapshot: snapshot(latestProject),
            error: null,
          },
          result.waiting ? (polling ? 'poll' : 'stage_waiting') : 'stage_output',
          { artifact: result.artifact },
          stage.id,
        )
        row = current(row)
        if (row.status === 'waiting') {
          schedule(row)
          return
        }
        retry = false
      }
    } catch (error) {
      try {
        row = current(row)
        if (row.status === 'cancelled') return
        const state = decode(row),
          entry = state.stages[row.cursor]
        // Keep checkpoints so retries reuse submitted tasks and completed media.
        const message =
          error instanceof PipelineInputRequired
            ? error.message
            : error instanceof CreativeError
              ? error.message
              : '阶段执行失败，请检查模型设置、素材和输入后重试。'
        if (entry) {
          entry.status = 'failed'
          entry.error = message
        }
        patch(
          row,
          { status: 'failed', stages: JSON.stringify(state.stages), error: message },
          'stage_failed',
          { message },
          entry?.id,
        )
      } catch {
        /* a deleted project cannot be resurrected by a worker */
      }
    }
  }
  function launch(row: RunRow, retry: boolean, polling = false) {
    if (workers.has(row.id)) return
    clearTimer(row.id)
    patch(row, { status: 'running', error: null }, polling ? 'poll' : 'continued', { retry })
    const promise = work(current(row), retry)
    workers.set(row.id, promise)
    void promise.finally(() => workers.delete(row.id))
  }
  function checked(projectId: number, runId: number, version: number) {
    const row = readRun(projectId, runId)
    if (row.version !== version) throw new CreativeError('流程状态已变化，请刷新后重试', 409)
    return row
  }
  return {
    start(projectId: number, revision: number) {
      const project = getCreativeProject(projectId)
      if (project.revision !== revision) throw new CreativeError('项目内容已修改，请刷新后重试', 409)
      const definition = getPipelineDefinition(project.category)
      if (!definition) throw new CreativeError('此旧类型没有独立制作流程，请使用现有编辑器')
      const existing = db
        .select()
        .from(schema.creativePipelineRuns)
        .where(
          and(
            eq(schema.creativePipelineRuns.projectId, projectId),
            notInArray(schema.creativePipelineRuns.status, ['completed', 'cancelled']),
          ),
        )
        .get()
      if (existing) throw new CreativeError('该项目已有未结束流程，请继续或结束现有流程', 409)
      const ts = now()
      const id = getInsertId(
        db
          .insert(schema.creativePipelineRuns)
          .values({
            projectId,
            definition: JSON.stringify(definition),
            snapshot: snapshot(project),
            revision,
            version: 1,
            status: 'ready',
            cursor: 0,
            stages: JSON.stringify(definition.stages.map((s) => freshStage(s.id))),
            createdAt: ts,
            updatedAt: ts,
          })
          .run(),
      )
      log(readRun(projectId, id), 'created', { pipeline: definition.id })
      return getPipelineState(projectId)
    },
    continue(projectId: number, runId: number, version: number, retry = false) {
      const row = reconcileRowRevision(checked(projectId, runId, version))
      if (workers.has(runId)) throw new CreativeError('当前阶段仍在执行，请稍候', 409)
      if (['completed', 'cancelled'].includes(row.status)) throw new CreativeError('流程已经结束')
      if (getCreativeProject(projectId).revision !== row.revision)
        throw new CreativeError('请先同步项目修改', 409)
      if (decode(row).stages[row.cursor]?.status === 'review')
        throw new CreativeError('请先审阅并确认当前阶段')
      if (row.status === 'failed' && !retry) throw new CreativeError('当前阶段失败，请选择重试')
      launch(row, retry)
      return getPipelineState(projectId)
    },
    resumeTool(
      projectId: number,
      runId: number,
      version: number,
      jobId: number,
      input: { remoteId?: string; retrySubmission?: boolean },
    ) {
      const row = checked(projectId, runId, version),
        state = decode(row)
      if (workers.has(runId) || ['completed', 'cancelled'].includes(row.status))
        throw new CreativeError('请先暂停当前流程再恢复制作任务', 409)
      const entry = state.stages[row.cursor]
      const runtime = entry?.artifact?.data?.toolRuntime as PipelineToolRuntime | undefined
      const step = runtime?.steps.find((step) => step.jobId === jobId)
      if (!step) throw new CreativeError('该任务不属于当前制作阶段', 404)
      if (getCreativeProject(projectId).revision !== row.revision)
        throw new CreativeError('请先同步项目修改', 409)
      const job = toolboxService.resume(projectId, jobId, input.remoteId, input.retrySubmission ?? false)
      step.status = job.status === 'completed' ? 'completed' : 'running'
      step.error = null
      step.remoteId = job.remoteId
      entry.status = 'waiting'
      entry.error = null
      patch(
        row,
        { status: 'paused', stages: JSON.stringify(state.stages), error: null },
        'tool_resumed',
        { jobId, retrySubmission: !!input.retrySubmission },
        entry.id,
      )
      launch(current(row), true)
      return getPipelineState(projectId)
    },
    pause(projectId: number, runId: number, version: number) {
      const row = checked(projectId, runId, version)
      if (!['running', 'waiting'].includes(row.status)) throw new CreativeError('当前流程无需暂停')
      clearTimer(runId)
      patch(row, { status: workers.has(runId) ? 'pausing' : 'paused' }, 'pause_requested', {})
      return getPipelineState(projectId)
    },
    approve(projectId: number, runId: number, version: number, edited?: unknown) {
      const row = checked(projectId, runId, version),
        state = decode(row),
        entry = state.stages[row.cursor]
      if (
        workers.has(runId) ||
        ['completed', 'cancelled'].includes(row.status) ||
        !entry ||
        entry.status !== 'review' ||
        !entry.artifact
      )
        throw new CreativeError('当前没有可确认的阶段', 409)
      const project = getCreativeProject(projectId)
      if (project.revision !== row.revision) throw new CreativeError('请先同步修改，再确认阶段', 409)
      if (edited !== undefined) {
        if (
          ['scene_plan', 'assets', 'edit', 'compose'].includes(entry.id) ||
          entry.artifact.data?.translatedShots
        )
          throw new CreativeError('此阶段请在对应编辑器修改内容，再同步流程')
        entry.artifact = { ...entry.artifact, ...narrativeArtifactSchema.parse(edited) }
      }
      db.transaction(() => {
        if (entry.id === 'scene_plan' || entry.id === 'edit') approveCreativeProject(projectId, row.revision)
        entry.status = 'completed'
        entry.approvedAt = now()
        const cursor = row.cursor + 1
        patch(
          row,
          {
            stages: JSON.stringify(state.stages),
            cursor,
            status: cursor === state.stages.length ? 'completed' : 'ready',
          },
          'approved',
          { artifact: entry.artifact },
          entry.id,
        )
      })
      return getPipelineState(projectId)
    },
    rewind(projectId: number, runId: number, version: number, stageId: string) {
      const row = checked(projectId, runId, version),
        state = decode(row)
      if (workers.has(runId) || ['completed', 'cancelled'].includes(row.status))
        throw new CreativeError('请先暂停正在执行的阶段；已结束流程需要重新创建', 409)
      const index = state.stages.findIndex((s) => s.id === stageId)
      if (index < 0 || index > row.cursor) throw new CreativeError('只能退回已执行或当前阶段')
      if (getCreativeProject(projectId).revision !== row.revision)
        throw new CreativeError('请先同步修改', 409)
      clearTimer(runId)
      const before = state.stages.slice(index)
      for (let i = index; i < state.stages.length; i++) state.stages[i] = freshStage(state.stages[i].id)
      patch(
        row,
        { cursor: index, status: 'ready', stages: JSON.stringify(state.stages), error: null },
        'rewound',
        { invalidated: before },
        stageId,
      )
      return getPipelineState(projectId)
    },
    sync(projectId: number, runId: number, version: number) {
      const row = checked(projectId, runId, version),
        state = decode(row),
        project = getCreativeProject(projectId)
      if (workers.has(runId) || ['completed', 'cancelled'].includes(row.status))
        throw new CreativeError('请先暂停正在执行的阶段；已结束流程需要重新创建', 409)
      if (project.revision === row.revision) return getPipelineState(projectId)
      const before = JSON.parse(row.snapshot),
        after = JSON.parse(snapshot(project))
      const same = (key: string) => JSON.stringify(before[key]) === JSON.stringify(after[key])
      let index = 0
      const manualPlan = ['title', 'brief', 'production'].every(same)
      if (manualPlan) index = state.stages.findIndex((s) => s.id === 'scene_plan')
      index = Math.max(0, Math.min(index, row.cursor))
      clearTimer(runId)
      const invalidated = state.stages.slice(index)
      for (let i = index; i < state.stages.length; i++) state.stages[i] = freshStage(state.stages[i].id)
      // Keep the user's actual timeline; never regenerate over manual shot/audio edits.
      const manualReview = manualPlan && state.stages[index].id === 'scene_plan' && project.shots.length > 0
      if (manualReview)
        state.stages[index] = {
          ...freshStage('scene_plan'),
          status: 'review',
          completedAt: now(),
          artifact: {
            summary: `已同步 ${project.shots.length} 个手动编辑的镜头`,
            content: project.shots
              .map(
                (s, i) =>
                  `${i + 1}. ${s.title} · ${s.duration} 秒\n${s.visualPrompt}\n字幕：${s.caption}\n旁白：${s.narration}`,
              )
              .join('\n\n'),
            checks: ['核对当前镜头、音轨与字幕，确认后继续'],
            data: { shots: project.shots, audio: project.audio, manual: true },
          },
        }
      patch(
        row,
        {
          cursor: index,
          status: manualReview ? 'review' : 'ready',
          revision: project.revision,
          snapshot: snapshot(project),
          stages: JSON.stringify(state.stages),
          error: null,
        },
        'synced',
        { invalidated, revision: project.revision },
        state.stages[index].id,
      )
      return getPipelineState(projectId)
    },
    cancel(projectId: number, runId: number, version: number) {
      const row = checked(projectId, runId, version)
      if (workers.has(runId)) throw new CreativeError('请先暂停并等待当前阶段结束', 409)
      if (['completed', 'cancelled'].includes(row.status)) throw new CreativeError('流程已经结束')
      clearTimer(runId)
      patch(row, { status: 'cancelled' }, 'cancelled', {})
      return getPipelineState(projectId)
    },
    async idle(runId: number) {
      await workers.get(runId)
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}
export const pipelineRunner = createPipelineRunner()
export function recoverCreativePipelines() {
  const rows = db
    .select()
    .from(schema.creativePipelineRuns)
    .where(
      notInArray(schema.creativePipelineRuns.status, [
        'ready',
        'paused',
        'review',
        'failed',
        'completed',
        'cancelled',
      ]),
    )
    .all()
  for (const row of rows) {
    const state = decode(row),
      entry = state.stages[row.cursor]
    if (entry?.status === 'running') entry.status = 'failed'
    patch(
      row,
      {
        status: 'paused',
        stages: JSON.stringify(state.stages),
        error: '服务重启，流程已暂停。检查已有任务后继续或重试。',
      },
      'interrupted',
      {},
      entry?.id,
    )
  }
  return rows.length
}
