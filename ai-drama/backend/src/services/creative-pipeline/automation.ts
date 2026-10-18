import { getCreativeProject } from '../creative-projects.js'
import type { StageContext, StageResult, PipelineArtifact } from './contracts.js'
import type { PipelineToolPhase, PipelineToolRuntime, PipelineToolStep } from './tool-contracts.js'

interface AutomationTools {
  toolPlan: (
    context: StageContext,
    phase: PipelineToolPhase,
  ) => PipelineToolStep[] | Promise<PipelineToolStep[]>
  runTools: (
    context: StageContext,
    steps: PipelineToolStep[],
    phase: PipelineToolPhase,
  ) => Promise<{ runtime: PipelineToolRuntime; waiting: boolean; revision: number }>
}
/** Both sides of a stage share one durable trace. A waiting post-process never reruns the stage. */
export function withPipelineAutomation(
  execute: (context: StageContext) => Promise<StageResult>,
  tools: AutomationTools,
) {
  return async (initial: StageContext): Promise<StageResult> => {
    let saved = initial.previous
    let runtime = saved?.data?.toolRuntime as PipelineToolRuntime | undefined
    let project = initial.project
    const save = (artifact: PipelineArtifact, revision?: number) => {
      runtime = (artifact.data?.toolRuntime as PipelineToolRuntime | undefined) ?? runtime
      saved = {
        ...artifact,
        data: { ...saved?.data, ...artifact.data, ...(runtime ? { toolRuntime: runtime } : {}) },
      }
      initial.checkpoint(saved, revision)
      if (revision !== undefined) project = getCreativeProject(project.id)
    }
    const context = (): StageContext => ({ ...initial, project, previous: saved, checkpoint: save })
    const phase = async (side: PipelineToolPhase) => {
      const ctx = context()
      if (side === 'after' && saved?.data?._pipelineBase)
        ctx.artifacts = {
          ...ctx.artifacts,
          [ctx.stage.id]: saved.data._pipelineBase as PipelineArtifact,
        }
      const planned = await tools.toolPlan(ctx, side)
      const result = await tools.runTools(ctx, planned, side)
      runtime = result.runtime
      if (result.revision !== project.revision) project = getCreativeProject(project.id)
      return result
    }
    const waiting = (): StageResult => ({
      waiting: true,
      revision: project.revision,
      artifact: {
        summary: saved?.summary || '正在执行本阶段制作工具',
        content: saved?.content || '流程会自动串联产物并写回项目，任务编号和进度保留在本阶段。',
        checks: saved?.checks || [],
        data: { ...saved?.data, toolRuntime: runtime },
      },
    })
    if ((await phase('before')).waiting) return waiting()
    const cachedBase = saved?.data?._pipelineBase as PipelineArtifact | undefined
    let result: StageResult
    if (cachedBase) result = { artifact: cachedBase, revision: project.revision }
    else {
      const ctx = context()
      if (runtime?.steps.length)
        ctx.artifacts = {
          ...ctx.artifacts,
          tool_results: {
            summary: '当前阶段已实际执行的工具结果',
            content: runtime.steps
              .filter((step) => step.status === 'completed')
              .map((step) => `${step.toolId}: ${step.writeback || step.reason}`)
              .join('\n'),
            checks: [],
            data: { toolRuntime: runtime },
          },
        }
      result = await execute(ctx)
      if (result.revision !== undefined) project = getCreativeProject(project.id)
      if (result.waiting)
        return {
          ...result,
          artifact: {
            ...result.artifact,
            data: { ...saved?.data, ...result.artifact.data, toolRuntime: runtime },
          },
        }
      const { toolRuntime: _runtime, _pipelineBase: _base, ...data } = result.artifact.data || {}
      const base = { ...result.artifact, data }
      save(
        { ...result.artifact, data: { ...data, toolRuntime: runtime, _pipelineBase: base } },
        project.revision,
      )
    }
    if ((await phase('after')).waiting) return waiting()
    const base = (saved?.data?._pipelineBase as PipelineArtifact | undefined) || result.artifact
    let finalData: Record<string, unknown> = { ...base.data, ...saved?.data, toolRuntime: runtime }
    if (initial.stage.id === 'assets')
      finalData.manifest = project.shots.map((shot) => ({
        shotId: shot.id,
        title: shot.title,
        mediaType: shot.mediaType,
        url: shot.mediaType === 'image' ? shot.imageUrl : shot.videoUrl,
        audioUrl: shot.audioUrl,
        duration: shot.duration,
        imageTaskId: shot.imageTaskId,
        videoTaskId: shot.videoTaskId,
      }))
    if (initial.stage.id === 'compose') {
      const processed =
        runtime?.steps.filter(
          (step) =>
            step.phase === 'after' &&
            step.status === 'completed' &&
            step.apply?.target === 'render' &&
            Array.isArray(step.data?.outputs),
        ) || []
      if (processed.length) {
        let outputs = Array.isArray(finalData.outputs) ? (finalData.outputs as { shotId?: string }[]) : []
        for (const step of processed) {
          const replacements = step.data!.outputs as { shotId?: string }[]
          if (step.apply?.shotId || step.shotId)
            outputs = outputs.map(
              (output) => replacements.find((item) => item.shotId === output.shotId) || output,
            )
          else outputs = replacements
        }
        finalData = { ...finalData, outputs, renderId: processed.at(-1)?.data?.renderId }
      }
    }
    return {
      revision: project.revision,
      artifact: { ...base, data: finalData },
    }
  }
}
