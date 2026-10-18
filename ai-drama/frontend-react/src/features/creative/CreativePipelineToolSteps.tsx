import { useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import type { CreativeProject } from '@/entities/creative/model'
import type { PipelineToolExecution, PipelineToolStep } from '@/entities/creative/pipeline'
import type { ToolboxDefinition } from '@/entities/creative/toolbox'
import { useProductionText } from '@/entities/creative/catalog'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Modal } from '@/shared/ui/Modal'
import { cn } from '@/shared/lib/cn'
import { CreativeProductionFiles } from './CreativeProductionFiles'
import { hintClass } from './CreativeFields'

const statuses: Record<PipelineToolExecution['status'], [string, string]> = {
  pending: ['等待执行', 'Pending'],
  running: ['正在执行', 'Running'],
  completed: ['已完成', 'Completed'],
  failed: ['需处理', 'Needs attention'],
  uncertain: ['提交结果待核实', 'Submission needs verification'],
  skipped: ['无需执行', 'Not required'],
}
const targets: Record<string, [string, string]> = {
  shot: ['对应镜头', 'Shot'],
  source: ['项目素材库', 'Project sources'],
  music: ['项目配乐', 'Project music'],
  narration: ['旁白音轨', 'Narration'],
  transcript: ['素材原稿与时码', 'Source transcript'],
  model: ['三维模型库', '3D models'],
  artifact: ['本阶段产物', 'Stage output'],
  delivery: ['交付文件', 'Delivery files'],
  render: ['成片结果', 'Rendered video'],
}
function ExecutionStep({
  step,
  planned,
  project,
  tools,
  allSteps,
  disabled,
  pending,
  onRecover,
}: {
  step: PipelineToolExecution
  planned: boolean
  project: CreativeProject
  tools: ToolboxDefinition[]
  allSteps: PipelineToolStep[]
  disabled: boolean
  pending: boolean
  onRecover: (input: { jobId: number; remoteId?: string; retrySubmission?: boolean }) => void
}) {
  const text = useProductionText()
  const [remoteId, setRemoteId] = useState('')
  const [confirmRetry, setConfirmRetry] = useState(false)
  const tool = tools.find((item) => item.id === step.toolId)
  const shot = project.shots.find((item) => item.id === step.shotId)
  const source = project.production?.sources.find((item) => item.id === step.sourceId)
  const uncertain = step.status === 'uncertain'
  const remoteService = uncertain || !!step.remoteId || tool?.provider !== 'local'
  const recoverable = !planned && (uncertain || step.status === 'failed') && !!step.jobId
  const status = statuses[step.status] ?? statuses.pending
  const input = step.resolvedArgs ?? step.args
  return (
    <li className="min-w-0 space-y-3 rounded-control border border-outline bg-elevated p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h4 className="flex items-center gap-2 break-words text-sm font-semibold">
            {step.status === 'running' ? (
              <Loader2 size={14} className="shrink-0 animate-spin" aria-hidden />
            ) : step.status === 'completed' ? (
              <Check size={14} className="shrink-0 text-success" aria-hidden />
            ) : null}
            {tool?.name ?? step.toolId}
          </h4>
          <p className={`${hintClass} mt-1`}>{step.reason}</p>
        </div>
        <span
          className={cn(
            'rounded-pill px-2 py-1 text-[11px]',
            ['failed', 'uncertain'].includes(step.status)
              ? 'bg-danger-soft text-danger'
              : 'bg-brand-soft text-brand-content',
          )}
        >
          {planned ? text('等待该阶段执行', 'Runs with this stage') : text(...status)}
        </span>
      </div>
      {(shot || source || step.jobId) && (
        <p className="break-words text-xs text-content-muted">
          {[shot?.title, source?.name, step.jobId ? text(`任务 #${step.jobId}`, `Task #${step.jobId}`) : '']
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {!!step.dependsOn.length && (
        <p className="text-xs text-content-muted">
          {text('接续产物：', 'Receives outputs from: ')}
          {step.dependsOn
            .map((key) => {
              const dependency = allSteps.find((item) => item.key === key)
              return tools.find((item) => item.id === dependency?.toolId)?.name ?? dependency?.toolId ?? key
            })
            .join(' → ')}
        </p>
      )}
      {step.status === 'running' && typeof step.progress === 'number' && (
        <div>
          <progress
            aria-label={text('工具执行进度', 'Tool progress')}
            max={100}
            value={Math.min(100, Math.max(0, step.progress))}
            className="h-2 w-full accent-brand"
          />
          <p className={hintClass}>{Math.round(step.progress)}%</p>
        </div>
      )}
      {planned && tool?.available === false && (
        <p className="text-xs text-brand-content">
          {tool.reason ||
            text(
              '需要配置服务或安装依赖；流程会在该步骤暂停。',
              'Setup is required; the workflow will pause at this step.',
            )}
        </p>
      )}
      {step.error && (
        <p role="alert" className="whitespace-pre-wrap break-words text-xs text-danger">
          {step.error}
        </p>
      )}
      {step.writeback && (
        <p className="rounded-control bg-brand-soft p-3 text-xs text-brand-content">
          {targets[step.writeback]
            ? `${text('已写入：', 'Written to: ')}${text(...targets[step.writeback])}`
            : step.writeback}
          {step.appliedRevision ? ` · ${text('项目版本', 'Project revision')} ${step.appliedRevision}` : ''}
        </p>
      )}
      {!step.writeback && step.apply && (
        <p className={hintClass}>
          {step.status === 'completed'
            ? text('产物用于：', 'Output used for: ')
            : text('完成后自动写入：', 'Automatically writes to: ')}
          {text(...targets[step.apply.target])}
          {step.apply.name ? ` · ${step.apply.name}` : ''}
        </p>
      )}
      {!!step.files?.length && <CreativeProductionFiles files={step.files} />}
      {recoverable && (
        <div className="space-y-3 border-t border-outline pt-3">
          {uncertain && (
            <p className={hintClass}>
              {text(
                '服务商可能已收到任务。填写原任务编号继续查询；流程不会自动重复提交。',
                'The provider may have received this task. Restore its original task ID to continue querying. The workflow will not resubmit it automatically.',
              )}
            </p>
          )}
          {remoteService && (
            <label className="block space-y-1">
              <span className="text-xs font-semibold">{text('服务商任务编号', 'Provider task ID')}</span>
              <Input
                aria-label={text(`任务 ${step.jobId} 的服务商编号`, `Provider ID for task ${step.jobId}`)}
                maxLength={300}
                value={remoteId}
                placeholder={
                  step.remoteId || text('从服务商任务记录查找', 'Find it in the provider task history')
                }
                disabled={disabled || pending}
                onChange={(event) => setRemoteId(event.target.value)}
              />
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            {remoteService && (
              <Button
                size="sm"
                disabled={disabled || pending || (!step.remoteId && !remoteId.trim())}
                onClick={() => onRecover({ jobId: step.jobId!, remoteId: remoteId.trim() || undefined })}
              >
                {text('恢复任务查询', 'Restore task query')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || pending}
              onClick={() => setConfirmRetry(true)}
            >
              {text('重新执行此工具', 'Run this tool again')}
            </Button>
          </div>
        </div>
      )}
      <details className="rounded-control border border-outline p-3">
        <summary className="cursor-pointer text-xs">
          {text('查看输入与结果记录', 'View input and output records')}
        </summary>
        <div className="mt-3 space-y-3">
          <p className="break-all text-[11px] text-content-muted">
            {step.toolId}
            {step.remoteId ? ` · ${text('服务任务', 'Provider task')}: ${step.remoteId}` : ''}
          </p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
            {JSON.stringify(input, null, 2)}
          </pre>
          {step.data && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-outline pt-3 text-xs">
              {JSON.stringify(step.data, null, 2)}
            </pre>
          )}
        </div>
      </details>
      <Modal
        open={confirmRetry}
        onOpenChange={setConfirmRetry}
        title={text('重新执行此工具', 'Run this tool again')}
        width={460}
        footer={
          <>
            <Button onClick={() => setConfirmRetry(false)}>{text('取消', 'Cancel')}</Button>
            <Button
              variant="primary"
              disabled={disabled || pending}
              onClick={() => {
                onRecover({ jobId: step.jobId!, retrySubmission: true })
                setConfirmRetry(false)
              }}
            >
              {text('确认重新执行', 'Confirm new execution')}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed">
          {remoteService
            ? text(
                '这会重新提交该工具任务。原云端任务可能仍在运行，再次提交可能产生额外费用；若已有服务商任务编号，请先恢复查询。新产物会继续由本阶段检查并回写。',
                'This submits a new tool task. The original remote task may still be running and a new submission may incur another charge. Restore the original provider task ID when available. This stage will validate and write back the new output.',
              )
            : text(
                '工具将使用已保存的输入重新执行。若输入有误，请先在制作要求中修正参数并同步流程。',
                'The tool will run again with its saved inputs. Correct any invalid production parameters and sync the workflow first.',
              )}
        </p>
      </Modal>
    </li>
  )
}

export function CreativePipelineToolSteps({
  steps,
  planned = false,
  project,
  tools,
  allSteps = steps,
  disabled,
  pending,
  onRecover,
}: {
  steps: PipelineToolExecution[]
  planned?: boolean
  project: CreativeProject
  tools: ToolboxDefinition[]
  allSteps?: PipelineToolStep[]
  disabled: boolean
  pending: boolean
  onRecover: (input: { jobId: number; remoteId?: string; retrySubmission?: boolean }) => void
}) {
  const text = useProductionText()
  if (!steps.length) return null
  return (
    <div className="my-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold">
          {text(
            planned ? '本阶段自动制作步骤' : '本阶段工具执行',
            planned ? 'Planned automation' : 'Stage tool execution',
          )}
        </h3>
        <p className={`${hintClass} mt-1`}>
          {text(
            '按依赖顺序传递真实素材，完成后自动检查并写入项目。',
            'Real media passes between dependent steps. Results are validated and written to the project automatically.',
          )}
        </p>
      </div>
      <ol className="m-0 list-none space-y-3 p-0">
        {steps.map((step) => (
          <ExecutionStep
            key={step.key}
            step={step}
            planned={planned}
            project={project}
            tools={tools}
            allSteps={allSteps}
            disabled={disabled}
            pending={pending}
            onRecover={onRecover}
          />
        ))}
      </ol>
    </div>
  )
}
