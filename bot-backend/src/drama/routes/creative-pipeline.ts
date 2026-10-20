import { Hono } from 'hono'
import { z } from 'zod'
import { success } from '../utils/response.js'
import {
  getPipelineState,
  getPipelineRun,
  pipelineRunner,
  type createPipelineRunner,
} from '../services/creative-pipeline/runner.js'
import { pipelineCapabilities } from '../services/creative-pipeline/executor.js'
import { getCreativeProject } from '../services/creative-projects.js'
import { getPipelineDefinition } from '../services/creative-pipeline/definitions.js'
import { planPipelineTools } from '../services/creative-pipeline/tool-planner.js'
import { pipelineToolPolicies } from '../services/creative-pipeline/tool-policy.js'
const actionSchema = z
  .object({
    version: z.number().int().positive(),
    action: z.enum(['continue', 'retry', 'pause', 'approve', 'rewind', 'sync', 'cancel']),
    stageId: z.string().max(80).optional(),
    edited: z.unknown().optional(),
  })
  .strict()
export function createPipelineRoutes(runner: ReturnType<typeof createPipelineRunner> = pipelineRunner) {
  const app = new Hono()
  app.get('/:id/pipeline', async (c) => success(c, await getPipelineState(Number(c.req.param('id')))))
  // 《重构》§6：客户端 Agent 认领（读准备好的提示词）与回交（产物注入后续跑）
  app.get('/:id/pipeline/:runId/agent-pending', async (c) =>
    success(c, await runner.pendingAgentStage(Number(c.req.param('id')), Number(c.req.param('runId')))))
  app.post('/:id/pipeline/:runId/agent-commit', async (c) => {
    const body = await c.req.json()
    return success(c, await runner.commitAgentArtifact(
      Number(c.req.param('id')), Number(c.req.param('runId')),
      Number(body.version), String(body.artifact ?? '')))
  })
  app.get('/:id/pipeline/capabilities', async (c) =>
    success(c, await pipelineCapabilities(Number(c.req.param('id')))),
  )
  app.get('/:id/pipeline/tool-plan', async (c) => {
    const project = await getCreativeProject(Number(c.req.param('id'))),
      definition = (getPipelineDefinition(project.category))
    const steps = [],
      issues: { stage: string; message: string }[] = []
    if (definition)
      for (const stage of definition.stages)
        for (const phase of ['before', 'after'] as const) {
          try {
            steps.push(
              ...(await planPipelineTools(
                {
                  project,
                  definition,
                  stage,
                  artifacts: {},
                  previous: null,
                  retry: false,
                  checkpoint: () => {},
                },
                phase,
              )),
            )
          } catch (error) {
            issues.push({
              stage: stage.id,
              message: error instanceof Error ? error.message : '工具输入尚未就绪',
            })
          }
        }
    return success(c, {
      steps,
      issues,
      policies: Object.values(pipelineToolPolicies).filter((policy) =>
        policy.categories.includes(project.category),
      ),
    })
  })
  app.get('/:id/pipeline/runs/:runId', async (c) =>
    success(c, await getPipelineRun(Number(c.req.param('id')), Number(c.req.param('runId')))),
  )
  app.post('/:id/pipeline', async (c) => {
    const { revision } = z
      .object({ revision: z.number().int().positive() })
      .strict()
      .parse(await c.req.json())
    return success(c, await runner.start(Number(c.req.param('id')), revision))
  })
  app.post('/:id/pipeline/:runId/actions', async (c) => {
    const id = Number(c.req.param('id')),
      runId = Number(c.req.param('runId'))
    const input = actionSchema.parse(await c.req.json()),
      args = [id, runId, input.version] as const
    switch (input.action) {
      case 'continue':
        return success(c, await runner.continue(...args))
      case 'retry':
        return success(c, await runner.continue(...args, true))
      case 'pause':
        return success(c, await runner.pause(...args))
      case 'approve':
        return success(c, await runner.approve(...args, input.edited))
      case 'rewind':
        return success(c, await runner.rewind(...args, input.stageId ?? ''))
      case 'sync':
        return success(c, await runner.sync(...args))
      case 'cancel':
        return success(c, await runner.cancel(...args))
    }
  })
  app.post('/:id/pipeline/:runId/tools/:jobId/resume', async (c) => {
    const input = z
      .object({
        version: z.number().int().positive(),
        remoteId: z.string().max(500).optional(),
        retrySubmission: z.boolean().optional(),
      })
      .strict()
      .parse(await c.req.json())
    return success(
      c,
      await runner.resumeTool(
        Number(c.req.param('id')),
        Number(c.req.param('runId')),
        input.version,
        Number(c.req.param('jobId')),
        input,
      ),
    )
  })
  return app
}
