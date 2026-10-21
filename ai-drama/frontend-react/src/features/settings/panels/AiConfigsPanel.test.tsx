// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { aiConfigApi, type AiConfig } from '@/entities/ai-config/model'
import { toolboxApi } from '@/entities/creative/toolbox'
import { initI18n } from '@/shared/config/i18n'
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

it('does not auto-provision while the configs list is still loading', async () => {
  // 目录先到、configs 永远 pending：此刻"配置缺失"是假象，建档会造重复行
  vi.spyOn(aiConfigApi, 'companyModels').mockImplementation(async (kind?: string) =>
    kind === 'text'
      ? { models: [{ id: 'deepseek-flash', displayName: 'DeepSeek Flash' }], defaultModel: 'deepseek-flash' } as const
      : { models: [], defaultModel: null })
  const never = new Promise<never>(() => {})
  vi.spyOn(aiConfigApi, 'list').mockImplementation(() => never)
  const create = vi.spyOn(aiConfigApi, 'create').mockResolvedValue({})
  mountPanel()
  // 目录 chips 已渲染（目录就绪），但建档必须按住不发
  await screen.findByRole('button', { name: /DeepSeek Flash/ })
  await new Promise((r) => setTimeout(r, 50))
  expect(create).not.toHaveBeenCalled()
})

it('targets the backend-resolved row when duplicate company rows exist', async () => {
  // 重复建档留下的现场：id=1（旧、空）与 id=9（新、有模型）并存。
  // 后端 rankConfigs 取 id=1 — 面板的点击也必须写到 id=1，否则默认模型永远传不进管道。
  vi.spyOn(aiConfigApi, 'companyModels').mockImplementation(async (kind?: string) =>
    kind === 'text'
      ? { models: [{ id: 'deepseek-flash', displayName: 'DeepSeek Flash' }, { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro' }], defaultModel: 'deepseek-flash' } as const
      : { models: [], defaultModel: null })
  const configs = [
    { ...config(1, ''), serviceType: 'text' as const, provider: 'company', models: [] },
    { ...config(9, 'deepseek-flash'), serviceType: 'text' as const, provider: 'company', models: ['deepseek-flash'] },
  ]
  vi.spyOn(aiConfigApi, 'list').mockResolvedValue(configs)
  const create = vi.spyOn(aiConfigApi, 'create').mockResolvedValue({})
  const update = vi.spyOn(aiConfigApi, 'update').mockResolvedValue(null)
  mountPanel()
  fireEvent.click(await screen.findByRole('button', { name: /DeepSeek V4 Pro/ }))
  await waitFor(() => expect(update).toHaveBeenCalledWith(1, expect.objectContaining({ model: ['deepseek-v4-pro'] })))
  expect(create).not.toHaveBeenCalled()
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

