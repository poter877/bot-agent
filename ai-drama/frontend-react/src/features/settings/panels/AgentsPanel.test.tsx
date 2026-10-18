// @vitest-environment jsdom
import { StrictMode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, configure, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promptApi, skillsApi, type PromptDetail } from '@/entities/ai-config/workspace-api'
import { settingsApi } from '@/entities/settings/api'
import { qk } from '@/shared/api/query-keys'
import { initI18n } from '@/shared/config/i18n'
import { AgentsPanel } from './AgentsPanel'

const remotePrompts: Record<string, string> = {}
configure({ asyncUtilTimeout: 10_000 })
const promptDetail = (agent: string, lang = 'zh'): PromptDetail => ({
  agent_type: agent, lang, name: agent, model: '', system_prompt: remotePrompts[`${agent}:${lang}`] ?? remotePrompts[agent] ?? `${agent} remote`, is_default: false,
})

function mountPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<StrictMode><QueryClientProvider client={client}><AgentsPanel /></QueryClientProvider></StrictMode>)
  return client
}
const editor = () => screen.getByRole('textbox') as HTMLTextAreaElement
const selectAgent = (name: string) => screen.getByRole('button', { name: new RegExp(name) })

beforeEach(async () => {
  await initI18n().changeLanguage('zh')
  Object.keys(remotePrompts).forEach((key) => delete remotePrompts[key])
  vi.spyOn(settingsApi, 'contentLanguage').mockResolvedValue({ language: 'zh' })
  vi.spyOn(promptApi, 'list').mockResolvedValue([])
  vi.spyOn(promptApi, 'get').mockImplementation(async (agent, lang) => promptDetail(agent, lang))
  vi.spyOn(skillsApi, 'list').mockResolvedValue([])
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('AgentsPanel prompt drafts', { timeout: 30_000 }, () => {
  it('loads the prompt after an asynchronous query and scopes drafts to each agent', async () => {
    const user = userEvent.setup()
    const update = vi.spyOn(promptApi, 'update').mockResolvedValue({})
    mountPanel()
    await waitFor(() => expect(editor().value).toBe('script_rewriter remote'))
    await user.clear(editor())
    await user.type(editor(), 'rewriter unsaved')
    await user.click(selectAgent('角色场景提取'))
    await waitFor(() => expect(editor().value).toBe('extractor remote'))
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('extractor', expect.objectContaining({ system_prompt: 'extractor remote' }), undefined))
    await user.click(selectAgent('剧本改写'))
    await waitFor(() => expect(editor().value).toBe('rewriter unsaved'))
  })

  it('follows background refreshes only while the current draft is clean', async () => {
    const user = userEvent.setup()
    const client = mountPanel()
    await waitFor(() => expect(editor().value).toBe('script_rewriter remote'))
    remotePrompts.script_rewriter = 'first remote refresh'
    await act(() => client.invalidateQueries({ queryKey: qk.promptDetail('script_rewriter', 'zh') }))
    await waitFor(() => expect(editor().value).toBe('first remote refresh'))
    await user.clear(editor())
    await user.type(editor(), 'local unsaved')
    remotePrompts.script_rewriter = 'second remote refresh'
    await act(() => client.invalidateQueries({ queryKey: qk.promptDetail('script_rewriter', 'zh') }))
    expect(editor().value).toBe('local unsaved')
  })

  it('keeps an in-flight save bound to its agent and preserves newer local edits', async () => {
    const user = userEvent.setup()
    let finishSave!: () => void
    const save = vi.spyOn(promptApi, 'update').mockImplementation((agent, payload) => new Promise((resolve) => {
      finishSave = () => { remotePrompts[agent] = payload.system_prompt; resolve({}) }
    }))
    mountPanel()
    await waitFor(() => expect(editor().value).toBe('script_rewriter remote'))
    await user.clear(editor())
    await user.type(editor(), 'submitted draft')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    await user.type(editor(), ' plus newer edits')
    await user.click(selectAgent('角色场景提取'))
    await waitFor(() => expect(editor().value).toBe('extractor remote'))
    await act(async () => finishSave())
    expect(editor().value).toBe('extractor remote')
    await user.click(selectAgent('剧本改写'))
    await waitFor(() => expect(editor().value).toBe('submitted draft plus newer edits'))
  })

  it('keeps separate drafts when the content language changes', async () => {
    const user = userEvent.setup()
    remotePrompts['script_rewriter:en'] = 'English prompt'
    const client = mountPanel()
    await waitFor(() => expect(editor().value).toBe('script_rewriter remote'))
    await user.clear(editor())
    await user.type(editor(), '中文草稿')
    act(() => client.setQueryData(qk.contentLanguage(), { language: 'en' }))
    await waitFor(() => expect(editor().value).toBe('English prompt'))
    act(() => client.setQueryData(qk.contentLanguage(), { language: 'zh' }))
    await waitFor(() => expect(editor().value).toBe('中文草稿'))
  })

  it('resets the intended agent even if selection changes during the request', async () => {
    const user = userEvent.setup()
    let finishReset!: () => void
    const reset = vi.spyOn(promptApi, 'reset').mockImplementation((agent) => new Promise((resolve) => {
      finishReset = () => { remotePrompts[agent] = 'reset prompt'; resolve({}) }
    }))
    mountPanel()
    await waitFor(() => expect(editor().value).toBe('script_rewriter remote'))
    await user.clear(editor())
    await user.type(editor(), 'unsaved')
    await user.click(screen.getByRole('button', { name: '恢复默认' }))
    await waitFor(() => expect(reset).toHaveBeenCalledOnce())
    await user.click(selectAgent('角色场景提取'))
    await waitFor(() => expect(editor().value).toBe('extractor remote'))
    await act(async () => finishReset())
    expect(editor().value).toBe('extractor remote')
    await user.click(selectAgent('剧本改写'))
    await waitFor(() => expect(editor().value).toBe('reset prompt'))
  })
})
