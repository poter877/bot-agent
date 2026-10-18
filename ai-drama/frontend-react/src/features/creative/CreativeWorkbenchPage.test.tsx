// @vitest-environment jsdom
import { toolboxApi } from '@/entities/creative/toolbox'
import { pipelineApi } from '@/entities/creative/pipeline'
import { creativeCatalogApi } from '@/entities/creative/catalog'
import { publicCreativeCatalog } from '../../../../backend/src/services/creative-catalog'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { creativeApi } from '@/entities/creative/api'
import { creativeQueries } from '@/entities/creative/queries'
import type { CreativeProject } from '@/entities/creative/model'
import { ApiError } from '@/shared/api/client'
import { uploadApi } from '@/shared/api/upload'
import { initI18n } from '@/shared/config/i18n'
import { CreativeWorkbenchPage } from './CreativeWorkbenchPage'

vi.mock('./CreativeChatPanel', () => ({ CreativeChatPanel: ({ disabled }: { disabled: boolean }) => <button type="button" disabled={disabled}>测试发送消息</button> }))

const baseProject: CreativeProject = {
  id: 42, title: '森林的一天', category: 'explainer', style: '3d', aspectRatio: '16:9', revision: 1, approvedRevision: null,
  brief: { idea: '讲解森林的生态', audience: '学生', tone: '轻松', targetDuration: 30, language: 'zh' },
  plan: { summary: '观察森林', script: '森林里的一天', musicDirection: '自然音' },
  shots: [{ id: 'first', title: '森林开场', duration: 5, visualPrompt: '晨光中的森林', narration: '太阳升起', caption: '森林苏醒', mediaType: 'image', imageUrl: null, videoUrl: null, imageTaskId: null, videoTaskId: null, trimStart: 0, originalVolume: 1 }],
  audio: { narrationUrl: null, musicUrl: null, musicVolume: 0.3, burnSubtitles: false }, renders: [], updatedAt: '2026-10-15T01:00:00Z',
}

function setup(project: CreativeProject = structuredClone(baseProject)) {
  vi.spyOn(creativeApi, 'get').mockResolvedValue(project)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  client.setQueryData(creativeQueries.detail(project.id).queryKey, project)
  const router = createMemoryRouter([
    { path: '/creative/:id', element: <CreativeWorkbenchPage projectId={project.id} /> },
    { path: '/', element: <div>启动台页面</div> },
    { path: '/settings', element: <div>设置页面</div> },
  ], { initialEntries: [`/creative/${project.id}`] })
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  fireEvent.click(screen.getByRole('tab', { name: '创作需求' }))
  return { client, project, router }
}

beforeEach(async () => {
  vi.spyOn(pipelineApi, 'toolPlan').mockResolvedValue({steps:[],policies:[]})
  vi.spyOn(toolboxApi, 'catalog').mockResolvedValue({tools:[],providers:[]})
  vi.spyOn(pipelineApi, 'get').mockResolvedValue({definition:null,run:null,history:[],events:[]})
  vi.spyOn(pipelineApi, 'capabilities').mockResolvedValue([])
  vi.spyOn(creativeCatalogApi, 'list').mockResolvedValue(publicCreativeCatalog())
  await initI18n().changeLanguage('zh')
  // jsdom AbortSignal and Node's Request are different realms; navigation here has no loaders to cancel.
  const NativeRequest = globalThis.Request
  vi.stubGlobal('Request', class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(input, { ...init, signal: undefined }) }
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('CreativeWorkbenchPage', { timeout: 30_000 }, () => {
  it('displays the server language code and exposes the optional audio workflow node', async () => {
    const user = userEvent.setup()
    const project = structuredClone(baseProject)
    project.brief.language = 'zh-CN'
    project.shots[0].caption = ''
    setup(project)
    expect(screen.getByRole('button', { name: '内容语言' }).textContent).toContain('中文')
    await user.click(screen.getByRole('button', { name: '可选 声音与字幕' }))
    expect(screen.getByRole('heading', { name: '旁白音轨' })).toBeTruthy()
  })

  it('keeps unsaved writing when task polling updates the server document', async () => {
    const { client, project } = setup()
    fireEvent.change(screen.getByRole('textbox', { name: '主题与创作要求' }), { target: { value: '我的未保存想法' } })
    act(() => client.setQueryData(creativeQueries.detail(project.id).queryKey, { ...project, brief: { ...project.brief, idea: '后台的新内容' } }))
    expect((screen.getByRole('textbox', { name: '主题与创作要求' }) as HTMLTextAreaElement).value).toBe('我的未保存想法')
    expect((screen.getByRole('button', { name: '测试发送消息' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '确认制作方案' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('saves a revisioned draft before allowing approval', async () => {
    const user = userEvent.setup()
    const { project } = setup()
    const save = vi.spyOn(creativeApi, 'save').mockImplementation(async (_id, draft) => ({ ...project, ...draft, revision: 2 }))
    fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: '新的森林标题' } })
    await user.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(save.mock.calls[0][0]).toBe(42)
    expect(save.mock.calls[0][1]).toMatchObject({ revision: 1, title: '新的森林标题' })
    await waitFor(() => expect((screen.getByRole('button', { name: '确认制作方案' }) as HTMLButtonElement).disabled).toBe(false))
    expect((screen.getByRole('button', { name: '保存修改' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('retains a draft on revision conflict and does not silently overwrite it', async () => {
    const user = userEvent.setup()
    setup()
    vi.spyOn(creativeApi, 'save').mockRejectedValue(new ApiError('版本冲突', 409, 409))
    fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: '需要保留的名称' } })
    await user.click(screen.getByRole('button', { name: '保存修改' }))
    await screen.findByText(/项目已在其他位置更新/)
    expect((screen.getByRole('textbox', { name: '项目名称' }) as HTMLInputElement).value).toBe('需要保留的名称')
    await user.click(screen.getByRole('button', { name: '重新加载' }))
    expect(screen.getByRole('dialog').textContent).toContain('替换当前未保存')
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect((screen.getByRole('textbox', { name: '项目名称' }) as HTMLInputElement).value).toBe('需要保留的名称')
  })

  it('protects unsaved changes on navigation', async () => {
    const user = userEvent.setup()
    setup()
    fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: '编辑中' } })
    await user.click(screen.getByRole('button', { name: '项目启动台' }))
    expect(screen.getByRole('dialog').textContent).toContain('离开后将丢失')
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByText('启动台页面')).toBeNull()
    await user.click(screen.getByRole('button', { name: '项目启动台' }))
    await user.click(screen.getByRole('button', { name: '放弃修改并离开' }))
    expect(await screen.findByText('启动台页面')).toBeTruthy()
  })

  it('generates the chosen shot only after approval and reports real API errors', async () => {
    const user = userEvent.setup()
    setup({ ...structuredClone(baseProject), approvedRevision: 1 })
    const generate = vi.spyOn(creativeApi, 'generate').mockRejectedValue(new ApiError('请先配置图像模型', 400, 400))
    await user.click(screen.getByRole('tab', { name: '画面编排' }))
    await user.click(screen.getByRole('button', { name: '生成图片' }))
    expect(generate).toHaveBeenCalledWith(42, 'first', 'image', 1)
    expect(await screen.findByText('请先配置图像模型')).toBeTruthy()
  })

  it('uploads a replacement as an unsaved change and clears the prior task reference', async () => {
    const user = userEvent.setup()
    const project = { ...structuredClone(baseProject), approvedRevision: 1 }
    project.shots[0].imageTaskId = 7
    project.shots[0].imageUrl = '/static/generated.png'
    setup(project)
    vi.spyOn(uploadApi, 'image').mockResolvedValue({ path: 'static/uploads/new.png', url: '/static/uploads/new.png' })
    const save = vi.spyOn(creativeApi, 'save').mockImplementation(async (_id, draft) => ({ ...project, ...draft, revision: 2, approvedRevision: null }))
    await user.click(screen.getByRole('tab', { name: '画面编排' }))
    const file = new File(['image'], 'new.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('上传图片', { selector: 'input' }), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByRole('img', { name: '森林开场' }).getAttribute('src')).toBe('/static/uploads/new.png'))
    expect((screen.getByRole('button', { name: '重新生成' }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(save.mock.calls[0][1].shots[0]).toMatchObject({ imageUrl: 'static/uploads/new.png', imageTaskId: null })
  })

  it('requires actual media before rendering and shows playable downloadable outputs', async () => {
    const user = userEvent.setup()
    const project = { ...structuredClone(baseProject), approvedRevision: 1 }
    project.renders = [{ id: 3, status: 'completed', progress: 100, videoUrl: 'static/creative/final.mp4', subtitleUrl: 'static/creative/final.srt', duration: 5, errorMsg: null, warnings: [], createdAt: '2026-10-15T00:00:00Z', revision: 1 }]
    setup(project)
    await user.click(screen.getByRole('tab', { name: '成片导出' }))
    expect((screen.getByRole('button', { name: '导出成片' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('link', { name: '下载视频' }).getAttribute('href')).toBe('/static/creative/final.mp4')
    expect(screen.getByRole('link', { name: '下载字幕' }).getAttribute('href')).toBe('/static/creative/final.srt')
    await user.click(screen.getByRole('button', { name: '预览' }))
    expect(screen.getByRole('dialog').querySelector('video')?.getAttribute('src')).toBe('/static/creative/final.mp4')
  })

  it('disables editing during active generation while showing live progress', async () => {
    const user = userEvent.setup()
    const project = structuredClone(baseProject)
    project.shots[0].imageTask = { id: 5, status: 'processing', errorMsg: null, localPath: null }
    setup(project)
    expect((screen.getByRole('textbox', { name: '项目名称' }).closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
    await user.click(screen.getByRole('tab', { name: '画面编排' }))
    expect((screen.getByRole('button', { name: '添加画面' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('生成中…')).toBeTruthy()
  })
})

it('uploads per-shot narration without replacing picture or video, then saves the draft',async()=>{
  const project=structuredClone(baseProject);project.shots[0].imageUrl='/static/uploads/portrait.png'
  setup(project)
  vi.spyOn(uploadApi,'audio').mockResolvedValue({path:'/static/uploads/voice.wav',url:'/static/uploads/voice.wav'})
  const save=vi.spyOn(creativeApi,'save').mockImplementation(async(_id,draft)=>({...project,...draft,revision:2}))
  fireEvent.click(screen.getByRole('tab',{name:'画面编排'}))
  fireEvent.change(screen.getByLabelText('上传镜头配音',{selector:'input'}),{target:{files:[new File(['audio'],'voice.wav',{type:'audio/wav'})]}})
  await screen.findByLabelText('片段音频')
  fireEvent.click(screen.getByRole('button',{name:'保存修改'}))
  await waitFor(()=>expect(save).toHaveBeenCalled())
  expect(save.mock.calls[0][1].shots[0]).toMatchObject({imageUrl:'/static/uploads/portrait.png',videoUrl:null,audioUrl:'/static/uploads/voice.wav',audioTrimStart:0})
})
