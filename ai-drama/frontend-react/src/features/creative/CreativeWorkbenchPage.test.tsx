// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toolboxApi } from '@/entities/creative/toolbox'
import { creativeApi } from '@/entities/creative/api'
import { pipelineApi } from '@/entities/creative/pipeline'
import { creativeCatalogApi } from '@/entities/creative/catalog'
import { initI18n } from '@/shared/config/i18n'
import { CreativeWorkbenchPage } from './CreativeWorkbenchPage'

const baseProject: import('@/entities/creative/model').CreativeProject = {
  id: 42, title: '测试项目', category: 'explainer', style: '3d', aspectRatio: '16:9', revision: 1, approvedRevision: null,
  brief: { idea: '主题', audience: '', tone: '', targetDuration: 30, language: 'zh-CN' },
  plan: { summary: '', script: '', musicDirection: '' },
  shots: [{ id: 's1', title: '开场', duration: 5, visualPrompt: '', narration: '', caption: '', mediaType: 'image', imageUrl: null, videoUrl: null, audioUrl: null, imageTaskId: null, videoTaskId: null, trimStart: 0, originalVolume: 1 }],
  audio: { narrationUrl: null, musicUrl: null, musicVolume: 0.2, burnSubtitles: false }, renders: [], updatedAt: '',
}

beforeEach(async () => {
  await initI18n().changeLanguage('zh')
  vi.spyOn(pipelineApi, 'get').mockResolvedValue({ definition: null, run: null, history: [], events: [] })
  vi.spyOn(pipelineApi, 'toolPlan').mockResolvedValue({ steps: [], policies: [] })
  vi.spyOn(pipelineApi, 'capabilities').mockResolvedValue([])
  vi.spyOn(toolboxApi, 'catalog').mockResolvedValue({ tools: [], providers: [] })
  vi.spyOn(toolboxApi, 'list').mockResolvedValue([])
  vi.spyOn(creativeCatalogApi, 'list').mockResolvedValue([])
  vi.spyOn(creativeApi, 'get').mockResolvedValue(baseProject)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/creative/42']}><CreativeWorkbenchPage projectId={42} /></MemoryRouter></QueryClientProvider>)
}

describe('CreativeWorkbenchPage（对话式制片布局）', { timeout: 30_000 }, () => {
  it('默认进入制片看板：阶段轨与分镜胶片条可见，Tab 只剩看板与工具目录', async () => {
    mount()
    await waitFor(() => expect(screen.getByRole('tab', { name: '制片看板' })).toBeTruthy())
    expect(screen.getByRole('tab', { name: '工具目录' })).toBeTruthy()
    await waitFor(() => expect(screen.getByText('Production Board')).toBeTruthy())
    expect(screen.getByText('STORYBOARD')).toBeTruthy()
    // 已移除的编辑器 Tab 不再出现
    for (const gone of ['创作需求', '画面编排', '声音与字幕', '成片导出']) {
      expect(screen.queryByRole('tab', { name: gone })).toBeNull()
    }
  })

  it('流程未建立时看板显示建立入口；无 draft/save 机制', async () => {
    mount()
    await waitFor(() => expect(screen.getByRole('button', { name: '建立制作流程' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: '保存修改' })).toBeNull()
  })

  it('切换到工具目录 Tab 正常渲染', async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByRole('tab', { name: '工具目录' }))
    expect(screen.getByRole('tab', { name: '工具目录' }).getAttribute('aria-selected')).toBe('true')
  })
})
