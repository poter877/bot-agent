// @vitest-environment jsdom
import { toolboxApi } from '@/entities/creative/toolbox'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { pipelineApi, type PipelineState, type PipelineRun } from '@/entities/creative/pipeline'
import type { CreativeProject } from '@/entities/creative/model'
import { initI18n } from '@/shared/config/i18n'
import { CreativePipelinePanel } from './CreativePipelinePanel'

const definition = {
  id: 'talking-head',
  category: 'talking_head',
  version: 1,
  title: '口播',
  delivery: 'movie' as const,
  stages: ['idea', 'script', 'scene_plan'].map((id, i) => ({
    id,
    title: ['创作简报', '脚本讲稿', '分镜编排'][i],
    review: true,
    instruction: '',
    requires: [],
    produces: [],
  })),
}
function state(status = 'review'): PipelineState {
  return {
    definition,
    history: [],
    events: [],
    run: {
      id: 7,
      projectId: 42,
      definition,
      revision: 3,
      version: 8,
      status,
      cursor: 0,
      stale: false,
      error: null,
      createdAt: '2026-10-15',
      updatedAt: '2026-10-15',
      stages: definition.stages.map((s, i) => ({
        id: s.id,
        status: i === 0 ? status : 'pending',
        attempt: i === 0 ? 1 : 0,
        artifact: i === 0 ? { summary: '简报摘要', content: '原始阶段产物', checks: ['检查原稿'] } : null,
        error: null,
        approvedAt: null,
        startedAt: null,
        completedAt: null,
      })),
    },
  }
}
function setup(value = state(), disabled = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  const onDirtyChange = vi.fn(),
    onOpenEditor = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <CreativePipelinePanel
        project={
          {
            id: 42,
            revision: 3,
            shots: [],
            production: { fields: {}, sources: [] },
          } as unknown as CreativeProject
        }
        state={value}
        loading={false}
        disabled={disabled}
        onReload={vi.fn()}
        onOpenEditor={onOpenEditor}
        onDirtyChange={onDirtyChange}
      />
    </QueryClientProvider>,
  )
  return { client, onDirtyChange, onOpenEditor }
}
beforeEach(async () => {
  vi.spyOn(pipelineApi, 'toolPlan').mockResolvedValue({ steps: [], policies: [] })
  vi.spyOn(toolboxApi, 'catalog').mockResolvedValue({ tools: [], providers: [] })
  await initI18n().changeLanguage('zh')
  vi.spyOn(pipelineApi, 'capabilities').mockResolvedValue([])
  vi.spyOn(pipelineApi, 'action').mockResolvedValue(state('ready'))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('submits edited artifacts with the actual run version and protects unconfirmed text', async () => {
  const { onDirtyChange } = setup()
  fireEvent.change(screen.getByRole('textbox', { name: '编辑阶段产物' }), {
    target: { value: '我修改后的创作简报' },
  })
  expect(onDirtyChange).toHaveBeenLastCalledWith(true)
  expect((screen.getByRole('button', { name: /02 脚本讲稿/ }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: '打开对应编辑器' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '确认此阶段' }))
  await waitFor(() =>
    expect(pipelineApi.action).toHaveBeenCalledWith(42, 7, {
      action: 'approve',
      version: 8,
      edited: { summary: '简报摘要', content: '我修改后的创作简报', checks: ['检查原稿'] },
    }),
  )
})
it('pauses waiting jobs without disabling the pause control', async () => {
  setup(state('waiting'))
  fireEvent.click(screen.getByRole('button', { name: '暂停流程' }))
  await waitFor(() =>
    expect(pipelineApi.action).toHaveBeenCalledWith(42, 7, {
      action: 'pause',
      stageId: undefined,
      version: 8,
    }),
  )
})
it('requires an explicit sync for stale project state', async () => {
  const value = state('failed')
  value.run!.stale = true
  setup(value)
  expect(screen.queryByRole('button', { name: '重试当前阶段' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '同步修改' }))
  expect(pipelineApi.action).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '确认' }))
  await waitFor(() =>
    expect(pipelineApi.action).toHaveBeenCalledWith(42, 7, {
      action: 'sync',
      stageId: undefined,
      version: 8,
    }),
  )
})
it('prevents start/approval while project edits are unsaved', () => {
  setup(state(), true)
  expect((screen.getByRole('button', { name: '确认此阶段' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '确认此阶段' }))
  expect(pipelineApi.action).not.toHaveBeenCalled()
})
it('structured translations cannot be edited as disconnected prose', () => {
  const value = state()
  value.run!.stages[0].artifact!.data = { translatedShots: [{ caption: '译文' }] }
  setup(value)
  expect(screen.queryByRole('textbox', { name: '编辑阶段产物' })).toBeNull()
  expect(screen.getByText('原始阶段产物')).toBeTruthy()
})
it('loads previous stage outputs without changing the active run', async () => {
  const value = state()
  value.history = [
    { id: 7, status: 'review', revision: 3, createdAt: '2026-10-15' },
    { id: 6, status: 'cancelled', revision: 2, createdAt: '2026-10-14' },
  ]
  const older = { ...value.run!, id: 6 } as PipelineRun
  older.stages = older.stages.map((s) => ({
    ...s,
    artifact: s.artifact ? { ...s.artifact, content: '之前确认的记录' } : null,
  }))
  vi.spyOn(pipelineApi, 'run').mockResolvedValue(older)
  setup(value)
  fireEvent.click(screen.getByText('最近制作轮次'))
  fireEvent.click(screen.getByRole('button', { name: /#6/ }))
  expect(await screen.findByText('之前确认的记录')).toBeTruthy()
  expect(pipelineApi.run).toHaveBeenCalledWith(42, 6)
  expect(pipelineApi.action).not.toHaveBeenCalled()
})

it('derives stale state immediately from the current document revision', () => {
  const value = state('ready')
  value.run!.revision = 2
  value.run!.stale = false
  setup(value)
  expect(screen.getByRole('button', { name: '同步修改' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '继续执行' })).toBeNull()
})

it('keeps a cancelled review artifact read-only', () => {
  const value = state()
  value.run!.status = 'cancelled'
  setup(value)
  expect(screen.queryByRole('button', { name: '确认此阶段' })).toBeNull()
  expect(screen.queryByRole('textbox', { name: '编辑阶段产物' })).toBeNull()
  expect(screen.getByRole('button', { name: '建立新一轮流程' })).toBeTruthy()
})

it('shows planned tools in their actual stage before execution', async () => {
  vi.mocked(pipelineApi.toolPlan).mockResolvedValue({
    steps: [
      {
        key: 'idea-diagram',
        toolId: 'diagram_render',
        stage: 'idea',
        phase: 'after',
        role: 'visual',
        reason: '为解释概念制作示意图',
        args: { title: '生态系统' },
        dependsOn: [],
        apply: { target: 'source', kind: 'image' },
      },
    ],
    policies: [],
  })
  vi.mocked(toolboxApi.catalog).mockResolvedValue({
    tools: [
      {
        id: 'diagram_render',
        name: '图表示意',
        category: 'graphics',
        provider: 'local',
        description: '',
        inputs: [],
        available: true,
      },
    ],
    providers: [],
  })
  setup()
  expect(await screen.findByText('本阶段自动制作步骤')).toBeTruthy()
  expect(screen.getByText('图表示意')).toBeTruthy()
  expect(screen.getByText(/完成后自动写入：项目素材库/)).toBeTruthy()
  expect(pipelineApi.action).not.toHaveBeenCalled()
})

it('shows completed outputs and their writeback beside the stage', async () => {
  const value = state('failed')
  value.run!.stages[0].artifact!.data = {
    toolRuntime: {
      version: 1,
      steps: [
        {
          key: 'diagram',
          toolId: 'diagram_render',
          stage: 'idea',
          phase: 'before',
          role: 'visual',
          reason: '将结构转成图解',
          args: {},
          resolvedArgs: { title: '结构' },
          dependsOn: [],
          status: 'completed',
          jobId: 19,
          progress: 100,
          files: [{ url: '/static/creative/42/diagram.png', name: '结构图', kind: 'image' }],
          writeback: '已写入项目素材库',
          appliedRevision: 3,
        },
      ],
    },
  }
  setup(value)
  expect(await screen.findByRole('img', { name: '结构图' })).toBeTruthy()
  expect(screen.getByText('已写入项目素材库 · 项目版本 3')).toBeTruthy()
})

function uncertainStage(): PipelineState {
  const value = state('failed')
  value.run!.stages[0].artifact!.data = {
    toolRuntime: {
      version: 1,
      steps: [
        {
          key: 'video',
          toolId: 'video_generator',
          stage: 'idea',
          phase: 'before',
          role: 'visual',
          reason: '制作镜头',
          args: {},
          dependsOn: [],
          status: 'uncertain',
          jobId: 20,
          progress: 0,
          error: '提交结果待核实',
        },
      ],
    },
  }
  return value
}

it('restores a stage tool with the original remote ID and current run version', async () => {
  const resume = vi.spyOn(pipelineApi, 'resumeTool').mockResolvedValue(state('waiting'))
  setup(uncertainStage())
  expect(resume).not.toHaveBeenCalled()
  expect((screen.getByRole('button', { name: '恢复任务查询' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('任务 20 的服务商编号'), { target: { value: 'remote-original' } })
  fireEvent.click(screen.getByRole('button', { name: '恢复任务查询' }))
  await waitFor(() =>
    expect(resume).toHaveBeenCalledWith(42, 7, 20, { version: 8, remoteId: 'remote-original' }),
  )
})

it('requires an explicit duplicate-submission confirmation for an uncertain tool', async () => {
  const resume = vi.spyOn(pipelineApi, 'resumeTool').mockResolvedValue(state('waiting'))
  setup(uncertainStage())
  fireEvent.click(screen.getByRole('button', { name: '重新执行此工具' }))
  expect(screen.getByRole('dialog').textContent).toContain('额外费用')
  expect(resume).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '确认重新执行' }))
  await waitFor(() => expect(resume).toHaveBeenCalledWith(42, 7, 20, { version: 8, retrySubmission: true }))
})

it('shows missing tool inputs as a stage issue without hiding the workflow', async () => {
  vi.mocked(pipelineApi.toolPlan).mockResolvedValue({
    steps: [],
    policies: [],
    issues: [
      { stage: 'idea', message: '请补充画面素材地址' },
      { stage: 'scene_plan', message: '其他阶段缺输入' },
    ],
  })
  setup()
  expect(await screen.findByText('请补充画面素材地址')).toBeTruthy()
  expect(screen.getByText('此阶段还需补充输入')).toBeTruthy()
  expect(screen.queryByText('其他阶段缺输入')).toBeNull()
  expect(screen.getByRole('button', { name: '确认此阶段' })).toBeTruthy()
})

it('offers local tool retry without asking for an unrelated provider task ID', async () => {
  const value = uncertainStage()
  const runtime = value.run!.stages[0].artifact!.data!.toolRuntime as {
    steps: { toolId: string; status: string }[]
  }
  runtime.steps[0].toolId = 'diagram_gen'
  runtime.steps[0].status = 'failed'
  vi.mocked(toolboxApi.catalog).mockResolvedValue({
    providers: [],
    tools: [
      {
        id: 'diagram_gen',
        name: '本地图解',
        provider: 'local',
        category: 'graphics',
        description: '',
        inputs: [],
        available: true,
      },
    ],
  })
  setup(value)
  await screen.findByText('本地图解')
  expect(screen.queryByLabelText('任务 20 的服务商编号')).toBeNull()
  expect(screen.queryByRole('button', { name: '恢复任务查询' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '重新执行此工具' }))
  expect(screen.getByRole('dialog').textContent).toContain('修正参数并同步流程')
  expect(screen.getByRole('dialog').textContent).not.toContain('额外费用')
})
