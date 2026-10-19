// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { aiConfigApi, type AiConfig } from '@/entities/ai-config/model'
import { toolboxApi } from '@/entities/creative/toolbox'
import { initI18n } from '@/shared/config/i18n'
import { qk } from '@/shared/api/query-keys'
import { AiConfigsPanel } from './AiConfigsPanel'

vi.mock('@/shared/config/theme', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }))
configure({ asyncUtilTimeout: 10_000 })

const config = (id: number, model: string): AiConfig => ({
  id, models: [model], serviceType: 'text', provider: 'openai', name: `Config ${id}`,
  baseUrl: '', apiKey: '', endpoint: '', queryEndpoint: '', priority: 0,
  isDefault: false, isActive: true, temperature: null, createdAt: '', updatedAt: '',
})

function mountPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><AiConfigsPanel /></QueryClientProvider>)
  return client
}

beforeEach(async () => {
  await initI18n().changeLanguage('zh')
  vi.spyOn(toolboxApi, 'catalog').mockResolvedValue({ tools: [], providers: [] })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('AiConfigsPanel interactions', { timeout: 30_000 }, () => {
  it('makes the selected configuration the default even when priorities are tied', async () => {
    const user = userEvent.setup()
    const configs = [config(1, 'first-config-model'), config(2, 'second-config-model')].map((item) => ({ ...item, serviceType: 'lipsync' as const }))
    vi.spyOn(aiConfigApi, 'list').mockImplementation(async () => configs.map((item) => ({ ...item })))
    vi.spyOn(aiConfigApi, 'update').mockImplementation(async (id, payload) => {
      const item = configs.find((row) => row.id === id)!
      if (Array.isArray(payload.model)) item.models = payload.model as string[]
      if (typeof payload.priority === 'number') item.priority = payload.priority
      return null
    })
    mountPanel()
    const firstModel = await screen.findByRole('button', { name: 'first-config-model' })
    const nextModel = screen.getByRole('button', { name: 'second-config-model' })
    const initialDefaultTitle = firstModel.title
    expect(nextModel.title).not.toBe(initialDefaultTitle)
    await user.click(nextModel)
    await waitFor(() => expect(nextModel.title).toBe(initialDefaultTitle))
    expect(firstModel.title).not.toBe(initialDefaultTitle)
  })

  it('keeps an IME confirmation in the model input and adds the model on a later Enter', async () => {
    const user = userEvent.setup()
    vi.spyOn(aiConfigApi, 'list').mockResolvedValue([])
    mountPanel()
    await user.click(screen.getByRole('button', { name: '添加口型同步服务' }))
    // 直连工具服务保留手动输入（公司五类只能从目录直选）
    const input = screen.getByPlaceholderText(/模型名/) as HTMLInputElement
    await user.type(input, '候选模型')
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 })
    expect(input.value).toBe('候选模型')
    expect(screen.queryByText('候选模型')).toBeNull()
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', isComposing: false, keyCode: 13 })
    expect(input.value).toBe('')
    expect(screen.getByText('候选模型')).toBeTruthy()
  })
})

it('sources company model chips from the kind-routed catalog proxy', async () => {
  vi.spyOn(aiConfigApi, 'list').mockResolvedValue([])
  const companyModels = vi.spyOn(aiConfigApi, 'companyModels').mockImplementation(async (kind?: string) =>
    kind === 'image'
      ? { models: [{ id: 'seedream-x', displayName: 'Seedream 目录项' }, { id: 'wan-x', displayName: 'wan-x' }], defaultModel: 'seedream-x' } as const
      : { models: [], defaultModel: null })
  const create = vi.spyOn(aiConfigApi, 'create').mockResolvedValue({})
  mountPanel()
  const chip = await screen.findByRole('button', { name: /Seedream 目录项/ })
  expect(screen.getByText('wan-x')).toBeTruthy()
  // 目录默认项在 chip 旁标注
  expect(chip.textContent).toContain('目录默认')
  expect(screen.getByText('wan-x').closest('button')!.textContent).not.toContain('目录默认')
  expect(companyModels).toHaveBeenCalledWith('image', expect.anything())
  // 公司五类不走弹窗：目录就绪即按目录默认零接触建档
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
    service_type: 'image', provider: 'company', model: ['seedream-x'],
  })))
})

it('creates a specialist service through the same configuration API', async () => {
  vi.spyOn(aiConfigApi, 'list').mockResolvedValue([])
  const create = vi.spyOn(aiConfigApi, 'create').mockResolvedValue({})
  mountPanel()
  fireEvent.click(screen.getByRole('button', { name: '添加口型同步服务' }))
  const dialog = screen.getByRole('dialog')
  const baseUrl = dialog.querySelector<HTMLInputElement>('input[name="base_url"]')!
  expect(baseUrl.value).toBe('https://api.sync.so')
  expect(baseUrl.readOnly).toBe(true)
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'test-secret' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
    service_type: 'lipsync', provider: 'sync', api_key: 'test-secret', model: ['lipsync-2', 'lipsync-2-pro', 'sync-3'],
  })))
})

it('edits a configured service with an empty key and tests by server-side ID', async () => {
  vi.spyOn(aiConfigApi, 'list').mockResolvedValue([{ ...config(7, 'gpt-4o-mini-tts'), serviceType: 'lipsync', hasApiKey: true }])
  const update = vi.spyOn(aiConfigApi, 'update').mockResolvedValue(null)
  const probe = vi.spyOn(aiConfigApi, 'test').mockResolvedValue({ ok: true, reachable: true })
  mountPanel()
  await screen.findByText('Config 7')
  fireEvent.click(screen.getByRole('button', { name: '编辑 Config 7' }))
  fireEvent.click(screen.getByRole('button', { name: '测试配置' }))
  await waitFor(() => expect(probe).toHaveBeenCalledWith(expect.objectContaining({ config_id: 7, api_key: '' })))
  expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('')
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(update).toHaveBeenCalledWith(7, expect.objectContaining({ api_key: '' })))
})

it('adds catalog-provided capabilities through the unified settings form', async () => {
  vi.mocked(toolboxApi.catalog).mockResolvedValue({ tools: [], providers: [{ provider: 'elevenlabs', serviceType: 'music', name: 'ElevenLabs 音乐', baseUrl: 'https://api.elevenlabs.io', models: ['music_v1'] }] })
  vi.spyOn(aiConfigApi, 'list').mockResolvedValue([])
  const create = vi.spyOn(aiConfigApi, 'create').mockResolvedValue({})
  mountPanel()
  fireEvent.click(await screen.findByRole('button', { name: '添加音乐与音效服务' }))
  expect(screen.getByRole('dialog').textContent).toContain('ElevenLabs 音乐')
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'music-secret' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ service_type: 'music', provider: 'elevenlabs', model: ['music_v1'], base_url: 'https://api.elevenlabs.io' })))
})
it('renders company services as catalog pickers and keeps catalog tool presets addable', async () => {
  vi.mocked(toolboxApi.catalog).mockResolvedValue({ tools: [], providers: [{ provider: 'openai', serviceType: 'image', name: 'OpenAI 旧工具', baseUrl: 'https://old.example.com', models: ['gpt-image-1', 'gpt-image-2'] }] })
  vi.spyOn(aiConfigApi, 'list').mockResolvedValue([])
  const create = vi.spyOn(aiConfigApi, 'create').mockResolvedValue({})
  mountPanel()
  await waitFor(() => expect(toolboxApi.catalog).toHaveBeenCalled())
  // 公司五类不再有“添加服务”弹窗（图片的添加按钮来自目录工具预设，公司类型文本则完全没有）
  expect(screen.queryByRole('button', { name: '添加文本服务' })).toBeNull()
  fireEvent.click(await screen.findByRole('button', { name: '添加图片服务' }))
  expect(screen.getByRole('button', { name: 'OpenAI 旧工具' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'legacy-secret' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ service_type: 'image', provider: 'openai', api_key: 'legacy-secret', base_url: 'https://old.example.com' })))
})

it('auto-provisions the company config from the catalog default and switches defaults on click', { timeout: 20_000 }, async () => {
  const companyModels = vi.spyOn(aiConfigApi, 'companyModels').mockImplementation(async (kind?: string) =>
    kind === 'image'
      ? { models: [{ id: 'seedream-x', displayName: 'Seedream X' }, { id: 'kiki', displayName: 'Kiki' }], defaultModel: 'seedream-x' } as const
      : { models: [], defaultModel: null })
  vi.spyOn(aiConfigApi, 'list').mockResolvedValue([])
  const create = vi.spyOn(aiConfigApi, 'create').mockResolvedValue({})
  const update = vi.spyOn(aiConfigApi, 'update').mockResolvedValue(null)
  const client = mountPanel()
  // 目录就绪 → 按目录默认零接触建档
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ service_type: 'image', provider: 'company', model: ['seedream-x'] })))
  expect(companyModels).toHaveBeenCalledWith('image', expect.anything())
  // 建档后刷新列表 → 点击 kiki 切换默认
  vi.mocked(aiConfigApi.list).mockResolvedValue([{ ...config(31, 'seedream-x'), serviceType: 'image', provider: 'company', models: ['seedream-x'], isActive: true }])
  await client.invalidateQueries()
  // 建档刷新后 chips 从 disabled 变为可点
  await waitFor(() => expect((screen.getByRole('button', { name: /Kiki/ }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: /Kiki/ }))
  await waitFor(() => expect(update).toHaveBeenCalledWith(31, expect.objectContaining({ model: ['kiki', 'seedream-x'] })))
})

it('restores and saves a ComfyUI workflow without replacing edits during refresh', async () => {
  const original = { ...config(12, 'comfyui-workflow'), serviceType: 'animation', provider: 'comfyui', serviceOptions: { workflow_json: { '6': { inputs: { text: 'original' }, class_type: 'CLIPTextEncode' } }, prompt_node: '6' } }
  vi.mocked(toolboxApi.catalog).mockResolvedValue({ tools: [], providers: [{ provider: 'comfyui', serviceType: 'animation', name: 'ComfyUI', baseUrl: 'http://127.0.0.1:8188', models: ['comfyui-workflow'], requiresApiKey: false }] })
  vi.spyOn(aiConfigApi, 'list').mockResolvedValue([original])
  const update = vi.spyOn(aiConfigApi, 'update').mockResolvedValue(null)
  const client = mountPanel()
  fireEvent.click(await screen.findByRole('button', { name: '编辑 Config 12' }))
  const input = screen.getByLabelText('服务参数（JSON）') as HTMLTextAreaElement
  expect(JSON.parse(input.value)).toEqual(original.serviceOptions)
  const edited = { ...original.serviceOptions, prompt_node: '7' }
  fireEvent.change(input, { target: { value: JSON.stringify(edited) } })
  act(() => client.setQueryData(qk.aiConfigs(), [{ ...original, serviceOptions: {} }]))
  expect(JSON.parse(input.value)).toEqual(edited)
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(update).toHaveBeenCalledWith(12, expect.objectContaining({ service_options: edited })))
})

it('keeps invalid service JSON for correction and does not save it', async () => {
  vi.spyOn(aiConfigApi, 'list').mockResolvedValue([])
  const create = vi.spyOn(aiConfigApi, 'create').mockResolvedValue({})
  mountPanel()
  fireEvent.click(screen.getByRole('button', { name: '添加口型同步服务' }))
  fireEvent.change(screen.getByLabelText('服务参数（JSON）'), { target: { value: '{unfinished' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await screen.findByRole('alert')
  expect((screen.getByLabelText('服务参数（JSON）') as HTMLTextAreaElement).value).toBe('{unfinished')
  expect(create).not.toHaveBeenCalled()
})

it('shows a neutral keyless state while retaining the public service address configuration', async () => {
  vi.mocked(toolboxApi.catalog).mockResolvedValue({ tools: [], providers: [{ provider: 'nasa', serviceType: 'stock', name: 'NASA', baseUrl: 'https://images-api.nasa.gov', models: ['search'], requiresApiKey: false }] })
  vi.spyOn(aiConfigApi, 'list').mockResolvedValue([{ ...config(21, 'search'), serviceType: 'stock', provider: 'nasa', hasApiKey: false }])
  mountPanel()
  const badge = await screen.findByText('无需密钥')
  expect(badge.className).toContain('bg-track')
  expect(badge.className).not.toContain('text-danger')
  fireEvent.click(screen.getByRole('button', { name: '编辑 Config 21' }))
  expect(screen.getByPlaceholderText('可选，此服务无需密钥')).toBeTruthy()
  expect(screen.getByText('此服务无需密钥，仍需保存服务地址配置。')).toBeTruthy()
})
