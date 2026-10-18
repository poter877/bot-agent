// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
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
function mount(disabled = false) {
  const onProjectUpdated = vi.fn(), onGoToStage = vi.fn(), onBusyChange = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><CreativeChatPanel project={project} disabled={disabled} onProjectUpdated={onProjectUpdated} onGoToStage={onGoToStage} onBusyChange={onBusyChange} /></QueryClientProvider>)
  return { onProjectUpdated, onGoToStage, onBusyChange }
}
it('sends current revision, applies the saved project and opens suggested workflow actions', async () => {
  const next = { ...project, revision: 2 }
  const assistant = { id: 2, role: 'assistant' as const, content: '已修改开场', status: 'completed', createdAt: '', actions: ['review' as const] }
  const send = vi.spyOn(creativeChatApi, 'send').mockResolvedValue({ project: next, messages: [assistant], message: assistant })
  vi.mocked(creativeChatApi.messages).mockResolvedValue([assistant])
  const callbacks = mount(); const user = userEvent.setup()
  await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false))
  await user.type(screen.getByRole('textbox'), '开场更温暖一点')
  await user.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(callbacks.onProjectUpdated).toHaveBeenCalledWith(next))
  expect(send).toHaveBeenCalledWith(17, 1, '开场更温暖一点')
  expect(callbacks.onBusyChange).toHaveBeenCalledWith(true)
  await user.click(screen.getByRole('button', { name: '查看并确认方案' }))
  expect(callbacks.onGoToStage).toHaveBeenCalledWith('shots')
})
it('retains failed input and exposes a retry without changing the project', async () => {
  vi.spyOn(creativeChatApi, 'send').mockRejectedValue(new Error('请配置文本模型'))
  const callbacks = mount(); const user = userEvent.setup()
  await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false))
  await user.type(screen.getByRole('textbox'), '做一个宣传片')
  await user.click(screen.getByRole('button', { name: '发送' }))
  expect((await screen.findByRole('alert')).textContent).toContain('请配置文本模型')
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('做一个宣传片')
  expect(callbacks.onProjectUpdated).not.toHaveBeenCalled()
})
it('blocks implicit submit while there are unsaved edits', async () => {
  const send = vi.spyOn(creativeChatApi, 'send'); mount(true)
  const input = screen.getByRole('textbox') as HTMLTextAreaElement
  expect(input.disabled).toBe(true)
  fireEvent.submit(input.closest('form')!)
  expect(send).not.toHaveBeenCalled()
})
it('restores busy state for an unfinished conversation after reopening', async () => {
  vi.mocked(creativeChatApi.messages).mockResolvedValue([{ id: 1, role: 'user', content: '修改', actions: [], status: 'pending', createdAt: '' }])
  const callbacks = mount()
  await waitFor(() => expect(callbacks.onBusyChange).toHaveBeenCalledWith(true))
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true)
})
