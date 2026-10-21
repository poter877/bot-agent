// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { creativeChatApi } from '@/entities/creative/chat-api'
import type { CreativeProject } from '@/entities/creative/model'
import { initI18n } from '@/shared/config/i18n'
import { CreativeChatPanel } from './CreativeChatPanel'
const project: CreativeProject = {
  id: 17, title: '宣传片', category: 'product', style: '3d', aspectRatio: '16:9', revision: 1, approvedRevision: null,
  brief: { idea: '产品', audience: '', tone: '', targetDuration: 30, language: 'zh-CN' },
  plan: { summary: '', script: '', musicDirection: '' }, shots: [],
  audio: { musicUrl: null, narrationUrl: null, musicVolume: 0.2, burnSubtitles: false }, renders: [], updatedAt: '',
}
beforeEach(async () => { await initI18n().changeLanguage('zh'); vi.spyOn(creativeChatApi, 'messages').mockResolvedValue([]) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><CreativeChatPanel project={project} /></QueryClientProvider>)
}

// 独立浏览器版：制作对话编排在桌面 Agent 车道（服务端代调已退役）——
// 这里只读历史并给出指引，不再有输入框与发送。
it('renders read-only history with the desktop-only hint (no composer)', async () => {
  vi.mocked(creativeChatApi.messages).mockResolvedValue([
    { id: 1, role: 'user', content: '开场更温暖一点', actions: [], status: 'completed', createdAt: '' },
    { id: 2, role: 'assistant', content: '已修改开场', actions: [], status: 'completed', createdAt: '' },
  ])
  mount()
  expect(await screen.findByText('开场更温暖一点')).toBeTruthy()
  expect(screen.getByText('已修改开场')).toBeTruthy()
  expect(screen.getByText(/制作对话需要桌面 app 中的 AI 会话/)).toBeTruthy()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
})

it('surfaces history load failure with a retry', async () => {
  vi.mocked(creativeChatApi.messages).mockRejectedValue(new Error('网络不可用'))
  mount()
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('对话暂时无法加载'))
  expect(screen.getByRole('button', { name: '重新加载' })).toBeTruthy()
})
