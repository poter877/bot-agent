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
  AgentStagePending,
} from './contracts.js'

type RunRow = typeof schema.creativePipelineRuns.$inferSelect
const snapshot = (project: Awaited<Awaited<ReturnType<typeof getCreativeProject>>>) =>
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
};
async function readRun(projectId: number, runId: number) {
  await getCreativeProject(projectId)
  const row = (await db
    .select()
    .from(schema.creativePipelineRuns)
    .where(
      and(eq(schema.creativePipelineRuns.projectId, projectId), eq(schema.creativePipelineRuns.id, runId)),
    ))[0]
  if (!row) throw new CreativeError('制作流程不存在', 404)
  return row
};
async function log(row: RunRow, kind: string, payload: unknown, stageId: string | null = null) {
  await db.insert(schema.creativePipelineEvents)
    .values({ runId: row.id, stageId, kind, payload: JSON.stringify(payload), createdAt: now() }).returning()
};
async function patch(
  row: RunRow,
  changes: Partial<Omit<RunRow, 'id' | 'projectId' | 'version'>>,
  kind: string,
  payload: unknown,
  stageId: string | null = null,
) {
  (await db.transaction(async (tx) => {
    const result = (await tx
      .update(schema.creativePipelineRuns)
      .set({ ...changes, version: row.version + 1, updatedAt: now() })
      .where(
        and(eq(schema.creativePipelineRuns.id, row.id), eq(schema.creativePipelineRuns.version, row.version)),
      )
      .returning({ id: schema.creativePipelineRuns.id }))
    if (!result.length) throw new CreativeError('流程状态已变化，请刷新后重试', 409)
    // CAS 成功即推进内存行的版本——同一调用链上顺序的后续 patch（如
    // stage_started 之后的 awaiting_agent/checkpoint）不再拿过期版本去撞 409。
    row.version += 1
    if (kind !== 'poll') log(row, kind, payload, stageId)
  }))
};
async function reconcileRowRevision(row: RunRow): Promise<RunRow> {
  const project = await getCreativeProject(row.projectId)
  if (project.revision === row.revision) return row
  // 活跃 run 的版本同步是「同步修改」动作的事——读路径在这里写库会与
  // launch/checkpoint 的 CAS 互相顶版本（曾把 checkpoint 顶成 409 未处理
  // rejection 直接打死进程）。终态 run 才做工具写回恢复。
  if (!['completed', 'cancelled'].includes(row.status)) return row
  const state = await decode(row),
    entry = state.stages[row.cursor]
  const revision = await reconcilePipelineToolRevision(row.projectId, row.revision, entry?.artifact ?? null)
  if (revision === null) return row
  try {
    await patch(
      row,
      { revision, snapshot: (await snapshot(project)), stages: JSON.stringify(state.stages) },
      'tool_writeback_recovered',
      { revision },
      entry?.id,
    )
  } catch {
    // 并发写已推进版本——读回当前行即可，读路径不该因写竞争失败
    return readRun(row.projectId, row.id)
  }
  return readRun(row.projectId, row.id)
}
export async function getPipelineState(projectId: number) {
  const project = await getCreativeProject(projectId)
  const rows = (await db
    .select()
    .from(schema.creativePipelineRuns)
    .where(eq(schema.creativePipelineRuns.projectId, projectId))
    .orderBy(desc(schema.creativePipelineRuns.id))
    .limit(10))
  const latest = rows[0] ? await reconcileRowRevision(rows[0]) : undefined
  return {
    definition: getPipelineDefinition(project.category),
    run: latest ? { ...decode(latest), stale: latest.revision !== project.revision } : null,
    history: rows.map(({ id, status, createdAt, revision }) => ({ id, status, createdAt, revision })),
    events: latest
      ? (await db
          .select()
          .from(schema.creativePipelineEvents)
          .where(eq(schema.creativePipelineEvents.runId, latest.id))
          .orderBy(desc(schema.creativePipelineEvents.id))
          .limit(50))
          .map(({ payload, ...event }) => ({ ...event, payload: JSON.parse(payload) }))
      : [],
  }
}
export async function getPipelineRun(projectId: number, runId: number) {
  return decode((await readRun(projectId, runId)))
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
  };
  async function schedule(row: RunRow) {
    clearTimer(row.id)
    const timer = (await setTimeout(async () => {
      timers.delete(row.id)
      try {
        const fresh = await current(row)
        if (fresh.status === 'waiting') (await launch(fresh, false, true))
      } catch {
        /* project may have been deleted */
      }
    }, pollMs))
    timer.unref?.()
    timers.set(row.id, timer)
  };
  async function checkpoint(row: RunRow, index: number, artifact: PipelineArtifact, revision?: number) {
    const project = revision === undefined ? null : await getCreativeProject(row.projectId)
    if (project && project.revision !== revision)
      throw new CreativeError('工具写回期间项目已修改，请同步后继续', 409)
    // 读-写之间可能被并发写推进版本（面板轮询、工具回写）：重读一次再试，
    // 仍冲突才上抛——不让 CAS 竞争以未处理 rejection 打死进程。
    for (let attempt = 0; attempt < 2; attempt++) {
      const fresh = (await current(row)),
        state = (await decode(fresh))
      state.stages[index].artifact = artifact;
      try {
        await patch(
          fresh,
          {
            stages: JSON.stringify(state.stages),
            ...(project ? { revision: project.revision, snapshot: snapshot(project) } : {}),
          },
          'checkpoint',
          { artifact },
          state.stages[index].id,
        )
        return
      } catch (error) {
        if (!(error instanceof CreativeError) || error.status !== 409 || attempt === 1) throw error
      }
    }
  };
  async function work(initial: RunRow, retry: boolean) {
    let row = await current(initial)
    try {
      while (row.status === 'running') {
        const state = (await decode(row)),
          project = await getCreativeProject(row.projectId)
        if (project.revision !== row.revision) {
          const recovered = (await reconcilePipelineToolRevision(
            row.projectId,
            row.revision,
            state.stages[row.cursor]?.artifact ?? null,
          ))
          if (recovered === null)
            throw new PipelineInputRequired('项目内容已修改，请先同步修改，后续阶段将重新检查。');
          await patch(
            row,
            { revision: recovered, snapshot: snapshot(project), stages: JSON.stringify(state.stages) },
            'tool_writeback_recovered',
            { revision: recovered },
            state.stages[row.cursor]?.id,
          )
          row = await current(row)
          continue
        }
        const stage = state.definition.stages[row.cursor],
          entry = state.stages[row.cursor]
        if (!stage || !entry) throw new Error('流程阶段记录无效')
        if (stage.requires.some((id) => !state.stages.some((s) => s.id === id && s.status === 'completed')))
          throw new Error('前序阶段尚未完成或确认')
        if (entry.status === 'review') {
          await patch(row, { status: 'review' }, 'review_required', {}, stage.id)
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
        entry.error = null;
        (await patch(
          row,
          { stages: JSON.stringify(state.stages), error: null },
          polling ? 'poll' : 'stage_started',
          { attempt: entry.attempt },
          stage.id,
        ))
        const accepted = Object.fromEntries(
          state.stages
            .slice(0, row.cursor)
            .filter((s) => s.status === 'completed' && s.artifact)
            .map((s) => [s.id, s.artifact!]),
        )
        let result
        try {
          result = await execute({
            project,
            definition: state.definition,
            stage,
            artifacts: accepted,
            previous: entry.artifact,
            retry,
            checkpoint: async (artifact, revision) => (await checkpoint(row, row.cursor, artifact, revision)),
          })
        } catch (err) {
          if (err instanceof AgentStagePending) {
            // 《重构》§6：服务端不代调模型——暂存准备好的提示词，等客户端 Agent 回交。
            // executor 期间可能有 checkpoint 推进过版本：重读后再写，避免 CAS 409。
            entry.status = 'waiting'
            entry.pendingAgent = err.prepared
            const fresh = await current(row)
            await patch(
              fresh,
              { status: 'waiting', stages: JSON.stringify(state.stages) },
              'awaiting_agent',
              { stage: stage.id },
              stage.id,
            )
            return
          }
          throw err
        }
        row = (await current(row))
        const latestProject = await getCreativeProject(row.projectId)
        const revision = result.revision ?? project.revision
        if (latestProject.revision !== revision)
          throw new PipelineInputRequired('阶段执行期间项目发生了修改，请同步修改后重试。')
        const updated = (await decode(row)),
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
        if (row.status === 'pausing' && status !== 'completed') status = 'paused';
        (await patch(
          row,
          {
            status,
            cursor,
            stages: JSON.stringify(updated.stages),
            revision,
            snapshot: (await snapshot(latestProject)),
            error: null,
          },
          result.waiting ? (polling ? 'poll' : 'stage_waiting') : 'stage_output',
          { artifact: result.artifact },
          stage.id,
        ))
        row = (await current(row))
        if (row.status === 'waiting') {
          await schedule(row)
          return
        }
        retry = false
      }
    } catch (error) {
      console.error('[creative-pipeline] stage failed:', row.id, 'cursor', row.cursor, error)
      try {
        row = (await current(row))
        if (row.status === 'cancelled') return
        const state = (await decode(row)),
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
        };
        (await patch(
          row,
          { status: 'failed', stages: JSON.stringify(state.stages), error: message },
          'stage_failed',
          { message },
          entry?.id,
        ))
      } catch {
        /* a deleted project cannot be resurrected by a worker */
      }
    }
  };
  async function launch(row: RunRow, retry: boolean, polling = false) {
    if (workers.has(row.id)) return
    clearTimer(row.id)
    patch(row, { status: 'running', error: null }, polling ? 'poll' : 'continued', { retry })
    const promise = work((await current(row)), retry)
    workers.set(row.id, promise)
    void promise.finally(() => workers.delete(row.id))
  };
  async function checked(projectId: number, runId: number, version: number) {
    const row = await readRun(projectId, runId)
    if (row.version !== version) throw new CreativeError('流程状态已变化，请刷新后重试', 409)
    return row
  }

  /** 《重构》§6：客户端 Agent 的准备上下文（waiting + pendingAgent 的当前阶段）。 */
  async function pendingAgentStage(projectId: number, runId: number) {
    const row = await readRun(projectId, runId)
    const decoded = decode(row)
    const stage = decoded.stages[row.cursor]
    if (row.status !== 'waiting' || !stage?.pendingAgent) return null
    return { stageId: stage.id, ...stage.pendingAgent }
  }

  /** 客户端 Agent 回交阶段产物：校验 → 注入（等价正常完成路径）→ 续跑。 */
  async function commitAgentArtifact(projectId: number, runId: number, version: number, artifactJson: string) {
    const row = await checked(projectId, runId, version)
    const decoded = decode(row)
    const index = row.cursor
    const stage = decoded.stages[index]
    if (row.status !== 'waiting' || !stage?.pendingAgent) {
      throw new CreativeError('当前阶段不在等待客户端 Agent 的状态', 409)
    }
    let parsed: { summary?: unknown; content?: unknown; checks?: unknown }
    try {
      parsed = JSON.parse(artifactJson)
    } catch {
      throw new CreativeError('产物不是合法 JSON（应返回 {"summary","content","checks"}）', 400)
    }
    if (typeof parsed.summary !== 'string' || typeof parsed.content !== 'string') {
      throw new CreativeError('产物缺少 summary/content 字段', 400)
    }
    const definition = decoded.definition ?? (await getPipelineState(projectId)).definition
    const stageDef = definition.stages.find((it) => it.id === stage.id)
    stage.artifact = {
      summary: parsed.summary,
      content: parsed.content,
      checks: Array.isArray(parsed.checks) ? parsed.checks.map(String) : [],
      data: {},
    }
    stage.error = null
    stage.pendingAgent = null
    stage.status = stageDef?.review ? 'review' : 'completed'
    stage.completedAt = stageDef?.review ? null : new Date().toISOString()
    const cursor = stage.status === 'completed' ? index + 1 : index
    const status: RunStatus = stageDef?.review ? 'review' : cursor === decoded.stages.length ? 'completed' : 'running'
    await patch(
      row,
      { status, cursor, stages: JSON.stringify(decoded.stages) },
      'agent_committed',
      { stage: stage.id },
      stage.id,
    )
    if (status === 'running') await launch(await current(row), false)
    return { status }
  }

  return {
    pendingAgentStage,
    commitAgentArtifact,

    async start(projectId: number, revision: number) {
      const project = await getCreativeProject(projectId)
      if (project.revision !== revision) throw new CreativeError('项目内容已修改，请刷新后重试', 409)
      const definition = (await getPipelineDefinition(project.category))
      if (!definition) throw new CreativeError('此旧类型没有独立制作流程，请使用现有编辑器')
      const existing = (await db
        .select()
        .from(schema.creativePipelineRuns)
        .where(and(
          eq(schema.creativePipelineRuns.projectId, projectId),
          notInArray(schema.creativePipelineRuns.status, ['completed', 'cancelled']),
        )))[0]
      if (existing) throw new CreativeError('该项目已有未结束流程，请继续或结束现有流程', 409)
      const ts = now()
      const [created] = await db
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
        .returning({ id: schema.creativePipelineRuns.id })
      const id = created.id;
      await log(await readRun(projectId, id), 'created', { pipeline: definition.id })
      return getPipelineState(projectId)
    },
    async continue(projectId: number, runId: number, version: number, retry = false) {
      const row = await reconcileRowRevision((await checked(projectId, runId, version)))
      if (workers.has(runId)) throw new CreativeError('当前阶段仍在执行，请稍候', 409)
      if (['completed', 'cancelled'].includes(row.status)) throw new CreativeError('流程已经结束')
      if (await (await getCreativeProject(projectId)).revision !== row.revision)
        throw new CreativeError('请先同步项目修改', 409)
      if ((await decode(row)).stages[row.cursor]?.status === 'review')
        throw new CreativeError('请先审阅并确认当前阶段')
      if (row.status === 'failed' && !retry) throw new CreativeError('当前阶段失败，请选择重试');
      (await launch(row, retry))
      return (await getPipelineState(projectId))
    },
    async resumeTool(
      projectId: number,
      runId: number,
      version: number,
      jobId: number,
      input: { remoteId?: string; retrySubmission?: boolean },
    ) {
      const row = (await checked(projectId, runId, version)),
        state = (await decode(row))
      if (workers.has(runId) || ['completed', 'cancelled'].includes(row.status))
        throw new CreativeError('请先暂停当前流程再恢复制作任务', 409)
      const entry = state.stages[row.cursor]
      const runtime = entry?.artifact?.data?.toolRuntime as PipelineToolRuntime | undefined
      const step = runtime?.steps.find((step) => step.jobId === jobId)
      if (!step) throw new CreativeError('该任务不属于当前制作阶段', 404)
      if (await (await getCreativeProject(projectId)).revision !== row.revision)
        throw new CreativeError('请先同步项目修改', 409)
      const job = toolboxService.resume(projectId, jobId, input.remoteId, input.retrySubmission ?? false)
      step.status = (await job).status === 'completed' ? 'completed' : 'running'
      step.error = null
      step.remoteId = (await job).remoteId
      entry.status = 'waiting'
      entry.error = null;
      (await patch(
        row,
        { status: 'paused', stages: JSON.stringify(state.stages), error: null },
        'tool_resumed',
        { jobId, retrySubmission: !!input.retrySubmission },
        entry.id,
      ));
      (await launch((await current(row)), true))
      return (await getPipelineState(projectId))
    },
    async pause(projectId: number, runId: number, version: number) {
      const row = await checked(projectId, runId, version)
      if (!['running', 'waiting'].includes(row.status)) throw new CreativeError('当前流程无需暂停');
      (await clearTimer(runId));
      (await patch(row, { status: workers.has(runId) ? 'pausing' : 'paused' }, 'pause_requested', {}))
      return (await getPipelineState(projectId))
    },
    async approve(projectId: number, runId: number, version: number, edited?: unknown) {
      const row = (await checked(projectId, runId, version)),
        state = (await decode(row)),
        entry = state.stages[row.cursor]
      if (
        workers.has(runId) ||
        ['completed', 'cancelled'].includes(row.status) ||
        !entry ||
        entry.status !== 'review' ||
        !entry.artifact
      )
        throw new CreativeError('当前没有可确认的阶段', 409)
      const project = await getCreativeProject(projectId)
      if (project.revision !== row.revision) throw new CreativeError('请先同步修改，再确认阶段', 409)
      if (edited !== undefined) {
        if (
          ['scene_plan', 'assets', 'edit', 'compose'].includes(entry.id) ||
          entry.artifact.data?.translatedShots
        )
          throw new CreativeError('此阶段请在对应编辑器修改内容，再同步流程')
        entry.artifact = { ...entry.artifact, ...narrativeArtifactSchema.parse(edited) }
      }
      (await db.transaction(async () => {
        if (entry.id === 'scene_plan' || entry.id === 'edit') (await approveCreativeProject(projectId, row.revision))
        entry.status = 'completed'
        entry.approvedAt = (await now())
        const cursor = row.cursor + 1;
        (await patch(
          row,
          {
            stages: JSON.stringify(state.stages),
            cursor,
            status: cursor === state.stages.length ? 'completed' : 'ready',
          },
          'approved',
          { artifact: entry.artifact },
          entry.id,
        ))
      }))
      return (await getPipelineState(projectId))
    },
    async rewind(projectId: number, runId: number, version: number, stageId: string) {
      const row = (await checked(projectId, runId, version)),
        state = (await decode(row))
      if (workers.has(runId) || ['completed', 'cancelled'].includes(row.status))
        throw new CreativeError('请先暂停正在执行的阶段；已结束流程需要重新创建', 409)
      const index = state.stages.findIndex((s) => s.id === stageId)
      if (index < 0 || index > row.cursor) throw new CreativeError('只能退回已执行或当前阶段')
      if ((await getCreativeProject(projectId)).revision !== row.revision)
        throw new CreativeError('请先同步修改', 409)
      clearTimer(runId)
      const before = state.stages.slice(index)
      for (let i = index; i < state.stages.length; i++) state.stages[i] = (await freshStage(state.stages[i].id));
      (await patch(
        row,
        { cursor: index, status: 'ready', stages: JSON.stringify(state.stages), error: null },
        'rewound',
        { invalidated: before },
        stageId,
      ))
      return getPipelineState(projectId)
    },
    async sync(projectId: number, runId: number, version: number) {
      const row = (await checked(projectId, runId, version)),
        state = (await decode(row)),
        project = await getCreativeProject(projectId)
      if (workers.has(runId) || ['completed', 'cancelled'].includes(row.status))
        throw new CreativeError('请先暂停正在执行的阶段；已结束流程需要重新创建', 409)
      if (project.revision === row.revision) return getPipelineState(projectId)
      const before = JSON.parse(row.snapshot),
        after = (await JSON.parse((await snapshot(project))))
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
          ...(await freshStage('scene_plan')),
          status: 'review',
          completedAt: now(),
          artifact: {
            summary: `已同步 ${project.shots.length} 个手动编辑的镜头`,
            content: project.shots
              .map(
                async (s, i) =>
                  `${i + 1}. ${(await s).title} · ${(await s).duration} 秒\n${(await s).visualPrompt}\n字幕：${(await s).caption}\n旁白：${(await s).narration}`,
              )
              .join('\n\n'),
            checks: ['核对当前镜头、音轨与字幕，确认后继续'],
            data: { shots: project.shots, audio: project.audio, manual: true },
          },
        };
      (await patch(
        row,
        {
          cursor: index,
          status: manualReview ? 'review' : 'ready',
          revision: project.revision,
          snapshot: (await snapshot(project)),
          stages: JSON.stringify(state.stages),
          error: null,
        },
        'synced',
        { invalidated, revision: project.revision },
        state.stages[index].id,
      ))
      return getPipelineState(projectId)
    },
    async cancel(projectId: number, runId: number, version: number) {
      const row = await checked(projectId, runId, version)
      if (workers.has(runId)) throw new CreativeError('请先暂停并等待当前阶段结束', 409)
      if (['completed', 'cancelled'].includes(row.status)) throw new CreativeError('流程已经结束');
      (await clearTimer(runId));
      (await patch(row, { status: 'cancelled' }, 'cancelled', {}))
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
export async function recoverCreativePipelines() {
  const rows = (await db
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
    ))
  for (const row of rows) {
    const state = await decode(row),
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
