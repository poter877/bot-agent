// @vitest-environment jsdom
/** 工作台顶栏模型下拉预选契约：未配置过预选目录默认项并标注「目录默认」，显式选择优先 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchContextValue } from '../WorkbenchProvider'
import type { ModelOption } from '../workbench-lib'
import { usePreferences } from '@/shared/config/preferences'
import { initI18n } from '@/shared/config/i18n'
import { WorkbenchTopbar } from './Topbar'

vi.mock('@/shared/config/theme', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }))

const videoOptions: ModelOption[] = [
  { key: '5:seedance', legacyKey: 'company/seedance', model: 'seedance', isCatalogDefault: true, provider: 'company', configId: 5, configName: '公司后端' },
  { key: '5:vidu-x', legacyKey: 'company/vidu-x', model: 'vidu-x', provider: 'company', configId: 5, configName: '公司后端' },
]

let wbMock = {} as WorkbenchContextValue
vi.mock('../WorkbenchProvider', () => ({ useWorkbench: () => wbMock }))
vi.mock('../workbench-store', () => ({
  useWorkbenchStore: (select: (s: Record<string, unknown>) => unknown) =>
    select({ taskDrawerOpen: false, setTaskDrawerOpen: vi.fn(), stage: 'script', scriptStep: 0, prodTab: 'assets' }),
}))

function mountTopbar() {
  wbMock = {
    dramaId: 1,
    episodeNumber: 1,
    episode: null,
    chars: [],
    scenes: [],
    props: [],
    sbs: [],
    visualChars: [],
    jobs: { tasks: [], merges: [] },
    textModelOptions: [],
    imageModelOptions: [],
    videoModelOptions: videoOptions,
    resolutionProvider: 'company',
    episodeResolution: '720p',
    changeEpisodeResolution: async () => {},
    refresh: async () => {},
  } as unknown as WorkbenchContextValue
  render(<WorkbenchTopbar dramaTitle="测试剧本" onBack={() => {}} onHelp={() => {}} />)
}

function videoTrigger(): HTMLButtonElement {
  return screen.getByText('视频').parentElement!.querySelector('button')!
}

beforeEach(async () => {
  await initI18n().changeLanguage('zh')
  usePreferences.setState({ modelPrefs: { chat: '', image: '', video: '' } })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('workbench topbar model preselection', { timeout: 30_000 }, () => {
  it('未配置过模型时预选目录默认项并标注「目录默认」', async () => {
    const user = userEvent.setup()
    mountTopbar()
    const trigger = videoTrigger()
    expect(trigger.textContent).toContain('seedance')
    expect(trigger.textContent).toContain('目录默认')
    await user.click(trigger)
    const defaultItem = screen.getByRole('menuitem', { name: /seedance/ })
    expect(defaultItem.getAttribute('aria-selected')).toBe('true')
    expect(defaultItem.textContent).toContain('目录默认')
    expect(screen.getByRole('menuitem', { name: /vidu-x/ }).getAttribute('aria-selected')).toBeNull()
  })

  it('显式选择过的模型优先于目录默认（沿用偏好持久化）', async () => {
    const user = userEvent.setup()
    usePreferences.setState({ modelPrefs: { chat: '', image: '', video: '5:vidu-x' } })
    mountTopbar()
    const trigger = videoTrigger()
    expect(trigger.textContent).toContain('vidu-x')
    expect(trigger.textContent).not.toContain('目录默认')
    await user.click(trigger)
    expect(screen.getByRole('menuitem', { name: /vidu-x/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('menuitem', { name: /seedance/ }).getAttribute('aria-selected')).toBeNull()
  })

  it('菜单选择写入模型偏好（现有选中持久化路径）', async () => {
    const user = userEvent.setup()
    mountTopbar()
    await user.click(videoTrigger())
    await user.click(screen.getByRole('menuitem', { name: /vidu-x/ }))
    expect(usePreferences.getState().modelPrefs.video).toBe('5:vidu-x')
    expect(videoTrigger().textContent).toContain('vidu-x')
  })
})
