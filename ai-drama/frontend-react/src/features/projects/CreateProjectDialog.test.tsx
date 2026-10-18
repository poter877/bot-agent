// @vitest-environment jsdom
import { creativeCatalogApi } from '@/entities/creative/catalog'
import { filmStylesApi } from '@/entities/film/model'
import { publicCreativeCatalog } from '../../../../backend/src/services/creative-catalog'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dramaApi } from '@/entities/drama/api'
import type { StylePreset } from '@/entities/settings/api'
import { initI18n } from '@/shared/config/i18n'
import { CreateProjectDialog } from './CreateProjectDialog'

const presets: StylePreset[] = [
  { id: 1, name: '3D 漫剧', value: '3d', description: '三维渲染', prompt: '', sortOrder: 1, isActive: true },
  { id: 2, name: '水彩绘本', value: 'watercolor', description: '水彩画风', prompt: '', sortOrder: 2, isActive: true },
  { id: 3, name: '日漫赛璐璐', value: 'anime', description: '日漫画风', prompt: '', sortOrder: 3, isActive: true },
]
const aspectRatios = [
  { label: '16:9 · 横屏', value: '16:9' },
  { label: '9:16 · 竖屏', value: '9:16' },
]

function renderDialog(initialPresets = presets) {
  const onClose = vi.fn()
  const onCreated = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })

  function TestDialog({ stylePresets }: { stylePresets: StylePreset[] }) {
    const [open, setOpen] = useState(true)
    return (
      <QueryClientProvider client={client}>
        <CreateProjectDialog
          open={open}
          onClose={() => { setOpen(false); onClose() }}
          stylePresets={stylePresets}
          aspectRatioOptions={aspectRatios}
          onCreated={onCreated}
        />
      </QueryClientProvider>
    )
  }

  const result = render(<TestDialog stylePresets={initialPresets} />)
  return { onClose, onCreated, updatePresets: (next: StylePreset[]) => result.rerender(<TestDialog stylePresets={next} />) }
}

beforeEach(async () => {
  vi.spyOn(creativeCatalogApi, 'list').mockResolvedValue(publicCreativeCatalog())
  vi.spyOn(filmStylesApi, 'groups').mockResolvedValue([])
  await initI18n().changeLanguage('zh')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('CreateProjectDialog selections', { timeout: 30_000 }, () => {
  it('creates a creative project with category and routes by project type', async () => {
    const user = userEvent.setup()
    const create = vi.spyOn(dramaApi, 'create').mockResolvedValue({ id: 42 })
    const { onCreated } = renderDialog()
    expect((screen.getByRole('radio', { name: '短剧项目' }) as HTMLInputElement).checked).toBe(true)
    await user.click(screen.getByRole('radio', { name: '创意视频' }))
    await user.click(screen.getByRole('radio', { name: '数字人讲解' }))
    fireEvent.change(screen.getByRole('textbox', { name: /项目名称/ }), { target: { value: '产品发布片' } })
    await user.click(screen.getByRole('button', { name: '创建项目' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(42, 'creative'))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: '产品发布片', project_type: 'creative', creative_category: 'avatar' }))
  })

  it('retains the form draft and creative category while switching project types', async () => {
    const user = userEvent.setup()
    renderDialog()
    fireEvent.change(screen.getByRole('textbox', { name: /项目名称/ }), { target: { value: '保留项目设置' } })
    await user.click(screen.getByRole('button', { name: /视觉风格/ }))
    await user.click(screen.getByRole('menuitem', { name: '水彩绘本' }))
    await user.click(screen.getByRole('button', { name: /画面比例/ }))
    await user.click(screen.getByRole('menuitem', { name: '9:16 · 竖屏' }))
    await user.click(screen.getByRole('radio', { name: '创意视频' }))
    await user.click(screen.getByRole('radio', { name: '实拍 + AI 混合' }))
    await user.click(screen.getByRole('radio', { name: '短剧项目' }))

    expect((screen.getByRole('textbox', { name: /项目名称/ }) as HTMLInputElement).value).toBe('保留项目设置')
    expect(screen.getByRole('button', { name: /视觉风格/ }).textContent).toContain('水彩绘本')
    expect(screen.getByRole('button', { name: /画面比例/ }).textContent).toContain('9:16')
    expect((screen.getByRole('button', { name: '创建项目' }) as HTMLButtonElement).disabled).toBe(false)
    await user.click(screen.getByRole('radio', { name: '创意视频' }))
    expect((screen.getByRole('radio', { name: '实拍 + AI 混合' }) as HTMLInputElement).checked).toBe(true)
  })

  it('supports keyboard selection in both radio groups without submitting the form', async () => {
    const user = userEvent.setup()
    const create = vi.spyOn(dramaApi, 'create').mockResolvedValue({ id: 42 })
    renderDialog()
    screen.getByRole('radio', { name: '创意视频' }).focus()
    await user.keyboard(' ')
    expect((screen.getByRole('radio', { name: '创意视频' }) as HTMLInputElement).checked).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: '创意视频' }))

    screen.getByRole('radio', { name: '数字人讲解' }).focus()
    await user.keyboard(' ')
    expect((screen.getByRole('radio', { name: '数字人讲解' }) as HTMLInputElement).checked).toBe(true)
    expect(create).not.toHaveBeenCalled()
  })

  it('locks project choices and the draft while a short drama is being created', async () => {
    const user = userEvent.setup()
    let resolveCreate!: (value: unknown) => void
    const create = vi.spyOn(dramaApi, 'create').mockImplementation(() => new Promise((resolve) => { resolveCreate = resolve }))
    const { onCreated, onClose } = renderDialog()
    fireEvent.change(screen.getByRole('textbox', { name: /项目名称/ }), { target: { value: '创建中的短剧' } })
    await user.click(screen.getByRole('button', { name: '创建项目' }))
    await waitFor(() => expect(create).toHaveBeenCalledOnce())

    expect((screen.getByRole('radio', { name: '创意视频' }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('textbox', { name: /项目名称/ }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /视觉风格/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true)
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()

    resolveCreate({ id: 42 })
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(42, 'drama'))
  })

  it('selects both fields inside the modal and submits their values', async () => {
    const user = userEvent.setup()
    const create = vi.spyOn(dramaApi, 'create').mockResolvedValue({ id: 42 })
    const { onCreated } = renderDialog()

    await user.type(screen.getByRole('textbox', { name: /项目名称/ }), '都市传说')
    await user.click(screen.getByRole('button', { name: /视觉风格/ }))
    await user.click(await screen.findByRole('menuitem', { name: '水彩绘本' }))
    expect(screen.getByRole('button', { name: /视觉风格/ }).textContent).toContain('水彩绘本')

    await user.click(screen.getByRole('button', { name: /画面比例/ }))
    await user.click(await screen.findByRole('menuitem', { name: '9:16 · 竖屏' }))
    expect(screen.getByRole('button', { name: /画面比例/ }).textContent).toContain('9:16')

    await user.click(screen.getByRole('button', { name: '创建项目' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith({ title: '都市传说', style: 'watercolor', aspect_ratio: '9:16' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(42, 'drama'))
  })

  it('keeps the search query and supports keyboard selection within the focus trap', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByRole('button', { name: /视觉风格/ }))
    const search = await screen.findByPlaceholderText('搜索...')
    await waitFor(() => expect(document.activeElement).toBe(search))
    await user.type(search, '水彩')

    expect((search as HTMLInputElement).value).toBe('水彩')
    expect(screen.queryByRole('menuitem', { name: '3D 漫剧' })).toBeNull()
    await user.keyboard('{ArrowDown}{Enter}')
    expect(screen.getByRole('button', { name: /视觉风格/ }).textContent).toContain('水彩绘本')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('closes the menu with Escape before closing the modal and restores trigger focus', async () => {
    const user = userEvent.setup()
    const { onClose } = renderDialog()
    const trigger = screen.getByRole('button', { name: /视觉风格/ })
    await user.click(trigger)
    await screen.findByRole('menu')
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(document.activeElement).toBe(trigger)
    expect(onClose).not.toHaveBeenCalled()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('dismisses a menu when another form field is clicked without losing the form draft', async () => {
    const user = userEvent.setup()
    const { onClose } = renderDialog()
    const title = screen.getByRole('textbox', { name: /项目名称/ })
    await user.type(title, '保留草稿')
    await user.click(screen.getByRole('button', { name: /画面比例/ }))
    await screen.findByRole('menu')
    await user.click(title)

    expect(screen.queryByRole('menu')).toBeNull()
    expect((title as HTMLInputElement).value).toBe('保留草稿')
    expect(onClose).not.toHaveBeenCalled()
  })

  it.each([{ isComposing: true }, { keyCode: 229 }])('does not select an option while confirming IME input (%o)', async (composition) => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByRole('button', { name: /视觉风格/ }))
    const search = screen.getByPlaceholderText('搜索...')
    fireEvent.change(search, { target: { value: '水彩' } })
    fireEvent.keyDown(search, { key: 'Enter', ...composition })

    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.getByRole('button', { name: /视觉风格/ }).textContent).toContain('3D 漫剧')
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(screen.getByRole('button', { name: /视觉风格/ }).textContent).toContain('水彩绘本')
  })

  it('preserves the form draft when presets refresh in the background', async () => {
    const user = userEvent.setup()
    const { updatePresets } = renderDialog()
    const title = screen.getByRole('textbox', { name: /项目名称/ })
    fireEvent.change(title, { target: { value: '保留创意' } })
    await user.click(screen.getByRole('button', { name: /视觉风格/ }))
    await user.click(screen.getByRole('menuitem', { name: '水彩绘本' }))
    await user.click(screen.getByRole('button', { name: /画面比例/ }))
    await user.click(screen.getByRole('menuitem', { name: '9:16 · 竖屏' }))

    updatePresets(presets.map((preset) => ({ ...preset, description: `${preset.description}（已更新）` })))

    expect((title as HTMLInputElement).value).toBe('保留创意')
    expect(screen.getByRole('button', { name: /视觉风格/ }).textContent).toContain('水彩绘本')
    expect(screen.getByRole('button', { name: /画面比例/ }).textContent).toContain('9:16')
  })

  it('fills the default style after presets load without clearing an entered title', () => {
    const { updatePresets } = renderDialog([])
    const title = screen.getByRole('textbox', { name: /项目名称/ })
    fireEvent.change(title, { target: { value: '加载时填写的项目' } })

    updatePresets(presets)

    expect((title as HTMLInputElement).value).toBe('加载时填写的项目')
    expect(screen.getByRole('button', { name: /视觉风格/ }).textContent).toContain('3D 漫剧')
  })
})

it.each(publicCreativeCatalog())('creates the $id type with its actual category identifier', async recipe => {
  const user = userEvent.setup()
  const create = vi.spyOn(dramaApi,'create').mockResolvedValue({id:90})
  const {onCreated} = renderDialog()
  await user.click(screen.getByRole('radio',{name:'创意视频'}))
  await user.click(await screen.findByRole('radio',{name:recipe.title.zh}))
  fireEvent.change(screen.getByRole('textbox',{name:/项目名称/}),{target:{value:recipe.title.zh}})
  await user.click(screen.getByRole('button',{name:'创建项目'}))
  await waitFor(()=>expect(onCreated).toHaveBeenCalledWith(90,'creative'))
  expect(create).toHaveBeenCalledWith(expect.objectContaining({creative_category:recipe.id}))
})

it('filters by group and search without silently replacing the selected type', async () => {
  const user = userEvent.setup()
  renderDialog()
  await user.click(screen.getByRole('radio',{name:'创意视频'}))
  await screen.findByRole('radio',{name:'长视频批量切片'})
  await user.click(screen.getByRole('radio',{name:'长视频批量切片'}))
  await user.click(screen.getByRole('button',{name:'故事与视觉'}))
  expect(screen.queryByRole('radio',{name:'长视频批量切片'})).toBeNull()
  expect(screen.getByText(/已选择：长视频批量切片/)).toBeTruthy()
  await user.click(screen.getByRole('button',{name:'全部类型'}))
  await user.type(screen.getByRole('textbox',{name:'搜索视频类型'}),'播客')
  expect(screen.getByRole('radio',{name:'播客转视频'})).toBeTruthy()
  expect(screen.queryByRole('radio',{name:'产品宣传'})).toBeNull()
})

it('offers only the twelve reference types and omits the two retired categories', async () => {
  const user = userEvent.setup()
  renderDialog()
  await user.click(screen.getByRole('radio', {name:'创意视频'}))
  await screen.findByText(/12 种可选风格/)
  expect(screen.queryByRole('radio',{name:'产品宣传'})).toBeNull()
  expect(screen.queryByRole('radio',{name:'素材混剪'})).toBeNull()
  expect(screen.getAllByRole('radio')).toHaveLength(14) // 2 project kinds + 12 video types
})
