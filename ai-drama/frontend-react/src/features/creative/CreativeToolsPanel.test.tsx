// @vitest-environment jsdom
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toolApi, type ToolJob } from '@/entities/creative/tools'
import { toCreativeDraft, type CreativeProject } from '@/entities/creative/model'
import { initI18n } from '@/shared/config/i18n'
import { CreativeToolsPanel } from './CreativeToolsPanel'
const project: CreativeProject = {
  id: 9,
  title: '工具测试',
  category: 'character_animation',
  style: '3d',
  aspectRatio: '16:9',
  revision: 3,
  approvedRevision: null,
  updatedAt: '',
  brief: { idea: '测试主题', audience: '', tone: '', targetDuration: 30, language: 'zh-CN' },
  plan: { summary: '', script: '', musicDirection: '' },
  audio: { narrationUrl: null, musicUrl: null, musicVolume: 0.2, burnSubtitles: false },
  shots: [],
  renders: [],
  production: { fields: { characters: '原有设定' }, sources: [] },
}
const job: ToolJob = {
  id: 17,
  kind: 'stock',
  status: 'completed',
  progress: 100,
  remoteId: null,
  error: null,
  createdAt: '2026-10-15T00:00:00Z',
  input: { query: '海洋' },
  result: {
    candidates: [
      {
        id: '7',
        kind: 'video',
        title: 'Ocean',
        preview: 'https://images.pexels.com/7.jpg',
        pageUrl: 'https://www.pexels.com/video/7',
        author: 'Artist',
        authorUrl: 'https://www.pexels.com/@artist',
        licenseUrl: 'https://www.pexels.com/license/',
        duration: 5,
      },
    ],
  },
}
const accepted = vi.fn(),
  busy = vi.fn()
function wrapper(children: React.ReactNode) {
  return (
    <MemoryRouter>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
        }
      >
        {children}
      </QueryClientProvider>
    </MemoryRouter>
  )
}
function mount(canRun = true) {
  function Harness() {
    const [draft, setDraft] = useState(() => toCreativeDraft(project))
    return (
      <>
        <CreativeToolsPanel
          project={project}
          draft={draft}
          disabled={false}
          canRun={canRun}
          onChange={setDraft}
          onProjectUpdated={accepted}
          onBusyChange={busy}
        />
        <output data-testid="draft">{JSON.stringify(draft.production)}</output>
      </>
    )
  }
  render(wrapper(<Harness />))
}
beforeEach(async () => {
  await initI18n().changeLanguage('zh')
  vi.spyOn(toolApi, 'list').mockResolvedValue({ jobs: [], models: [] })
  accepted.mockReset()
  busy.mockReset()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
it('submits saved revision and chosen search query', async () => {
  const start = vi.spyOn(toolApi, 'start').mockResolvedValue(job)
  mount()
  fireEvent.change(screen.getByLabelText('搜索主题'), { target: { value: '海洋' } })
  await userEvent.click(screen.getByRole('button', { name: '搜索素材' }))
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith(9, 3, 'stock', { query: '海洋', media: 'video' }, false),
  )
  expect(busy).toHaveBeenLastCalledWith(false)
})
it('cannot start external jobs while project has unsaved edits', () => {
  mount(false)
  fireEvent.change(screen.getByLabelText('搜索主题'), { target: { value: '海洋' } })
  expect((screen.getByRole('button', { name: '搜索素材' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: '上传人形 GLB' }) as HTMLButtonElement).disabled).toBe(true)
})
it('automatic options preserve existing requirements', () => {
  mount()
  fireEvent.click(screen.getByLabelText('流程开始时自动检索资料'))
  fireEvent.change(screen.getByLabelText('资料检索词（留空使用创作主题）'), { target: { value: '深海' } })
  expect(JSON.parse(screen.getByTestId('draft').textContent!).fields).toEqual({
    characters: '原有设定',
    researchMode: 'tavily',
    researchQuery: '深海',
  })
})
it('imports selected candidate with revision and shows attribution', async () => {
  vi.mocked(toolApi.list).mockResolvedValue({ jobs: [job], models: [] })
  const imported = vi.spyOn(toolApi, 'import').mockResolvedValue({ ...project, revision: 4 })
  mount()
  await screen.findByText('Artist')
  fireEvent.click(screen.getByRole('button', { name: '下载到项目素材库' }))
  await waitFor(() => expect(imported).toHaveBeenCalledWith(9, 17, '7', 3))
  await waitFor(() => expect(accepted).toHaveBeenCalledWith(expect.objectContaining({ revision: 4 })))
  expect(screen.getByRole('link', { name: '许可' }).getAttribute('href')).toBe(
    'https://www.pexels.com/license/',
  )
})
it('uncertain tasks require a remote identifier before recovery', async () => {
  vi.mocked(toolApi.list).mockResolvedValue({
    jobs: [{ ...job, kind: 'rigging', status: 'uncertain', result: {} }],
    models: [],
  })
  const resume = vi.spyOn(toolApi, 'resume').mockResolvedValue(job)
  mount()
  const button = await screen.findByRole('button', { name: '恢复任务查询' })
  expect((button as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('服务商任务编号'), { target: { value: 'meshy-123' } })
  fireEvent.click(button)
  await waitFor(() => expect(resume).toHaveBeenCalledWith(9, 17, 'meshy-123'))
  expect(screen.queryByRole('button', { name: '重新制作' })).toBeNull()
})
it('new task submission requires explicit confirmation and preserves input', async () => {
  vi.mocked(toolApi.list).mockResolvedValue({ jobs: [job], models: [] })
  const start = vi.spyOn(toolApi, 'start').mockResolvedValue(job)
  mount()
  fireEvent.click(await screen.findByRole('button', { name: '重新检索' }))
  expect(start).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '提交新任务' }))
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith(9, 3, 'stock', expect.objectContaining({ query: '海洋' }), true),
  )
})
