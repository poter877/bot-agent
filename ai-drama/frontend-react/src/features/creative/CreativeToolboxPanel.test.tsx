// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { aiConfigApi, type AiConfig } from '@/entities/ai-config/model'
import { toolboxApi, toolboxArguments, toolboxQueries, type ToolboxDefinition, type ToolboxJob } from '@/entities/creative/toolbox'
import type { CreativeProject } from '@/entities/creative/model'
import { initI18n } from '@/shared/config/i18n'
import { CreativeToolboxPanel } from './CreativeToolboxPanel'

const project: CreativeProject = {
  id: 9, title: '工具测试', category: 'explainer', style: '3d', aspectRatio: '16:9', revision: 3,
  approvedRevision: null, updatedAt: '', brief: { idea: '测试', audience: '', tone: '', targetDuration: 30, language: 'zh-CN' },
  plan: { summary: '', script: '', musicDirection: '' }, audio: { narrationUrl: null, musicUrl: null, musicVolume: 0.2, burnSubtitles: false },
  shots: [{ id: 'shot-1', title: '开场', duration: 5, visualPrompt: '', narration: '', caption: '', mediaType: 'video', imageUrl: null, videoUrl: '/static/input.mp4', imageTaskId: null, videoTaskId: null, trimStart: 0, originalVolume: 1 }], renders: [],
  production: { fields: {}, sources: [{ id: 'source-1', name: '海洋', kind: 'video', url: '/static/ocean.mp4', duration: 5, coverUrl: null, transcript: '', attribution: '' }] },
}
const localTool: ToolboxDefinition = {
  id: 'video_resize', name: '调整视频画幅', description: '调整视频尺寸与适配方式', category: 'editing', provider: 'local', available: true,
  inputs: [{ key: 'video', label: '输入视频', type: 'media', accept: 'video/*', required: true }, { key: 'width', label: '宽度', type: 'number', default: 1080 }, { key: 'settings', label: '高级参数', type: 'json', default: { fit: 'contain' } }, { key: 'sound', label: '保留声音', type: 'boolean', default: true }],
}
const remoteTool: ToolboxDefinition = {
  id: 'music_generate', name: '生成背景音乐', description: '根据文字生成配乐', category: 'audio', provider: 'elevenlabs', serviceType: 'music', available: true,
  inputs: [{ key: 'prompt', label: '音乐要求', type: 'text', required: true }],
}
const job: ToolboxJob = { id: 17, toolId: localTool.id, status: 'completed', progress: 100, error: null, input: { toolId: localTool.id, args: { video: '/static/input.mp4', width: 1080 } }, result: { summary: '完成', files: [{ url: '/static/output.mp4', name: '输出.mp4', kind: 'video' }] }, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:01:00Z' }
const config: AiConfig = { id: 5, serviceType: 'music', provider: 'elevenlabs', name: '音乐配置', baseUrl: 'https://api.elevenlabs.io', apiKey: '', hasApiKey: true, models: ['music_v1'], endpoint: '', queryEndpoint: '', priority: 1, isDefault: false, isActive: true, temperature: null, createdAt: '', updatedAt: '' }
const accepted = vi.fn(), busy = vi.fn()
function mount(canRun = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<MemoryRouter><QueryClientProvider client={client}><CreativeToolboxPanel project={project} disabled={false} canRun={canRun} onProjectUpdated={accepted} onBusyChange={busy} /></QueryClientProvider></MemoryRouter>)
  return client
}
beforeEach(async () => {
  await initI18n().changeLanguage('zh')
  vi.spyOn(toolboxApi, 'catalog').mockResolvedValue({ tools: [localTool, remoteTool], providers: [] })
  vi.spyOn(toolboxApi, 'list').mockResolvedValue([])
  vi.spyOn(aiConfigApi, 'list').mockResolvedValue([config])
  accepted.mockReset(); busy.mockReset()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('submits editable local tool inputs and the saved project revision', async () => {
  const start = vi.spyOn(toolboxApi, 'start').mockResolvedValue(job)
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /调整视频画幅/ }))
  fireEvent.change(screen.getByLabelText('输入视频 *'), { target: { value: '/static/ocean.mp4' } })
  fireEvent.change(screen.getByLabelText('宽度'), { target: { value: '720' } })
  fireEvent.click(screen.getByLabelText('保留声音'))
  fireEvent.click(screen.getByRole('button', { name: '执行工具' }))
  await waitFor(() => expect(start).toHaveBeenCalledWith(9, 3, 'video_resize', { video: '/static/ocean.mp4', width: 720, settings: { fit: 'contain' }, sound: false }, undefined))
})
it('preserves editing when catalog and task queries refresh', async () => {
  const client = mount()
  fireEvent.click(await screen.findByRole('button', { name: /调整视频画幅/ }))
  fireEvent.change(screen.getByLabelText('宽度'), { target: { value: '731' } })
  act(() => {
    client.setQueryData(toolboxQueries.catalog().queryKey, { tools: [{ ...localTool, description: '新目录说明' }, remoteTool], providers: [] })
    client.setQueryData(toolboxQueries.project(9).queryKey, [{ ...job, status: 'running', progress: 50 }])
  })
  expect((screen.getByLabelText('宽度') as HTMLInputElement).value).toBe('731')
  await waitFor(() => expect(screen.getAllByText('新目录说明').length).toBeGreaterThan(0))
})
it('retains the new task when an older initial history request finishes later', async () => {
  let finishOldRequest: (jobs: ToolboxJob[]) => void = () => undefined
  vi.mocked(toolboxApi.list).mockImplementationOnce(() => new Promise(resolve => { finishOldRequest = resolve })).mockResolvedValue([job])
  vi.spyOn(toolboxApi, 'start').mockResolvedValue(job)
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /调整视频画幅/ }))
  fireEvent.change(screen.getByLabelText('输入视频 *'), { target: { value: '/static/input.mp4' } })
  fireEvent.click(screen.getByRole('button', { name: '执行工具' }))
  await screen.findByRole('button', { name: '加入项目素材库' })
  act(() => finishOldRequest([]))
  expect(screen.getByRole('button', { name: '加入项目素材库' })).toBeTruthy()
})
it('shows invalid JSON without sending a task', async () => {
  const start = vi.spyOn(toolboxApi, 'start').mockResolvedValue(job)
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /调整视频画幅/ }))
  fireEvent.change(screen.getByLabelText('输入视频 *'), { target: { value: '/static/input.mp4' } })
  fireEvent.change(screen.getByLabelText('高级参数'), { target: { value: '{draft' } })
  fireEvent.click(screen.getByRole('button', { name: '执行工具' }))
  expect(screen.getByRole('alert').textContent).toContain('JSON 格式不正确')
  expect(start).not.toHaveBeenCalled()
})
it('uses the shared matching configuration and blocks unsaved project execution', async () => {
  const start = vi.spyOn(toolboxApi, 'start').mockResolvedValue({ ...job, toolId: remoteTool.id })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /生成背景音乐/ }))
  fireEvent.change(screen.getByLabelText('音乐要求 *'), { target: { value: '舒缓钢琴' } })
  fireEvent.click(screen.getByRole('button', { name: '执行工具' }))
  await waitFor(() => expect(start).toHaveBeenCalledWith(9, 3, remoteTool.id, { prompt: '舒缓钢琴' }, 5))
})
it('requires matching service and provider instead of using an unrelated model', async () => {
  vi.mocked(aiConfigApi.list).mockResolvedValue([{ ...config, provider: 'other' }])
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /生成背景音乐/ }))
  expect((screen.getByRole('button', { name: '执行工具' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(/需要启用 elevenlabs/)).toBeTruthy()
})
it('allows shared tools to choose a matching capability from any provider', async () => {
  vi.mocked(toolboxApi.catalog).mockResolvedValue({ tools: [{ ...remoteTool, provider: 'shared' }], providers: [] })
  const start = vi.spyOn(toolboxApi, 'start').mockResolvedValue(job)
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /生成背景音乐/ }))
  fireEvent.change(screen.getByLabelText('音乐要求 *'), { target: { value: '爵士' } })
  fireEvent.click(screen.getByRole('button', { name: '执行工具' }))
  await waitFor(() => expect(start).toHaveBeenCalledWith(9, 3, remoteTool.id, { prompt: '爵士' }, 5))
})
it('blocks task execution for an unsaved project', async () => {
  mount(false)
  fireEvent.click(await screen.findByRole('button', { name: /调整视频画幅/ }))
  expect((screen.getByRole('button', { name: '执行工具' }) as HTMLButtonElement).disabled).toBe(true)
})
it('recovers an uncertain task only after a remote identifier is supplied', async () => {
  vi.mocked(toolboxApi.list).mockResolvedValue([{ ...job, status: 'uncertain', result: null }])
  const resume = vi.spyOn(toolboxApi, 'resume').mockResolvedValue(job)
  mount()
  const button = await screen.findByRole('button', { name: '恢复任务查询' })
  expect((button as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('服务商任务编号'), { target: { value: 'remote-123' } })
  fireEvent.click(button)
  await waitFor(() => expect(resume).toHaveBeenCalledWith(9, 17, 'remote-123'))
  expect(screen.queryByRole('button', { name: '复用参数' })).toBeNull()
})
it('imports the chosen media output into the project using revision control', async () => {
  vi.mocked(toolboxApi.list).mockResolvedValue([job])
  const apply = vi.spyOn(toolboxApi, 'apply').mockResolvedValue({ ...project, revision: 4 })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: '加入项目素材库' }))
  await waitFor(() => expect(apply).toHaveBeenCalledWith(9, 17, 3, { fileUrl: '/static/output.mp4', sourceName: undefined }))
  expect(accepted).toHaveBeenCalledWith(expect.objectContaining({ revision: 4 }))
})
it('writes a subtitle result to the selected original source', async () => {
  vi.mocked(toolboxApi.list).mockResolvedValue([{ ...job, result: { files: [{ url: '/static/result.srt', name: '字幕.srt', kind: 'subtitle' }] } }])
  const apply = vi.spyOn(toolboxApi, 'apply').mockResolvedValue({ ...project, revision: 4 })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: '选择字幕对应的原始素材' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '海洋' }))
  fireEvent.click(screen.getByRole('button', { name: '写入素材字幕' }))
  await waitFor(() => expect(apply).toHaveBeenCalledWith(9, 17, 3, { fileUrl: '/static/result.srt', sourceId: 'source-1' }))
  await screen.findByText('字幕已写入素材，可在创作需求中检查并编排。')
})
it('adds GLB output to the shared three-dimensional model library', async () => {
  vi.mocked(toolboxApi.list).mockResolvedValue([{ ...job, result: { files: [{ url: '/static/model.glb', name: '模型.glb', kind: 'model' }] } }])
  const apply = vi.spyOn(toolboxApi, 'apply').mockResolvedValue({ ...project, revision: 4 })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: '加入三维模型库' }))
  await waitFor(() => expect(apply).toHaveBeenCalledWith(9, 17, 3, { fileUrl: '/static/model.glb' }))
  expect((await screen.findByRole('button', { name: '已加入三维模型库' }) as HTMLButtonElement).disabled).toBe(true)
})
it('uploads a model file directly into the tool input', async () => {
  vi.mocked(toolboxApi.catalog).mockResolvedValue({ tools: [{ ...localTool, inputs: [{ key: 'model', label: '人形模型', type: 'media', accept: '.glb', required: true }] }], providers: [] })
  const upload = vi.spyOn(toolboxApi, 'upload').mockResolvedValue({ url: '/static/toolbox/uploads/model.glb', name: 'model.glb', kind: 'model' })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /调整视频画幅/ }))
  const file = new File(['glTF'], 'model.glb', { type: 'model/gltf-binary' })
  fireEvent.change(screen.getByLabelText('上传人形模型'), { target: { files: [file] } })
  await waitFor(() => expect(upload).toHaveBeenCalledWith(9, file))
  await waitFor(() => expect((screen.getByLabelText('人形模型 *') as HTMLInputElement).value).toBe('/static/toolbox/uploads/model.glb'))
})
it('collects source arrays in chosen order without requiring hand-written paths', async () => {
  vi.mocked(toolboxApi.catalog).mockResolvedValue({ tools: [{ ...localTool, inputs: [{ key: 'sourceUrls', label: '拼接素材', type: 'json', required: true }] }], providers: [] })
  const start = vi.spyOn(toolboxApi, 'start').mockResolvedValue(job)
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /调整视频画幅/ }))
  fireEvent.click(screen.getByLabelText('镜头视频 · 开场'))
  fireEvent.click(screen.getByLabelText('素材 · 海洋'))
  fireEvent.click(screen.getByRole('button', { name: '执行工具' }))
  await waitFor(() => expect(start).toHaveBeenCalledWith(9, 3, localTool.id, { sourceUrls: ['/static/input.mp4', '/static/ocean.mp4'] }, undefined))
})
it('selects a shot identifier through the project shot picker', async () => {
  vi.mocked(toolboxApi.catalog).mockResolvedValue({ tools: [{ ...localTool, inputs: [{ key: 'shotId', label: '人物镜头', type: 'text', required: true }] }], providers: [] })
  const start = vi.spyOn(toolboxApi, 'start').mockResolvedValue(job)
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /调整视频画幅/ }))
  fireEvent.change(screen.getByLabelText('人物镜头 *'), { target: { value: 'shot-1' } })
  fireEvent.click(screen.getByRole('button', { name: '执行工具' }))
  await waitFor(() => expect(start).toHaveBeenCalledWith(9, 3, localTool.id, { shotId: 'shot-1' }, undefined))
})
it('hides script URLs in result links and does not render HTML as an embedded page', async () => {
  vi.mocked(toolboxApi.list).mockResolvedValue([{ ...job, result: { files: [{ name: 'unsafe', url: 'javascript:alert(1)', kind: 'data' }, { name: 'scene.html', url: '/static/scene.html', kind: 'data' }] } }])
  mount()
  await screen.findByText('unsafe：输出地址无法预览')
  expect(screen.getByRole('link', { name: 'scene.html' }).getAttribute('download')).toBe('')
  expect(document.querySelector('iframe')).toBeNull()
  expect(document.querySelector('a[href^="javascript:"]')).toBeNull()
})
it('renders stock candidates and starts a selected download with the original account and query', async () => {
  const stock: ToolboxDefinition = { ...remoteTool, id: 'pexels_video', name: '搜索视频素材', serviceType: 'stock', provider: 'pexels' }
  vi.mocked(toolboxApi.catalog).mockResolvedValue({ tools: [stock], providers: [] })
  vi.mocked(toolboxApi.list).mockResolvedValue([{ ...job, toolId: stock.id, input: { toolId: stock.id, configId: 42, args: { query: '海洋', media_type: 'video', count: 8, download: false } }, result: { data: { provider: 'pexels', items: [{ id: 'ocean-9', title: '海边落日', url: 'https://www.pexels.com/video/9', preview: 'https://images.pexels.com/photos/9/preview.jpg', downloadUrl: 'https://videos.pexels.com/video-files/9/video.mp4', kind: 'video', author: 'Ocean Artist', license: 'Pexels License', licenseUrl: 'https://www.pexels.com/license/', duration: 12 }] } } }])
  const start = vi.spyOn(toolboxApi, 'start').mockResolvedValue(job)
  mount()
  await screen.findByRole('heading', { name: '海边落日' })
  expect(screen.getByText('Ocean Artist')).toBeTruthy()
  expect(screen.getByRole('img', { name: '海边落日' }).getAttribute('src')).toBe('https://images.pexels.com/photos/9/preview.jpg')
  const source = screen.getByRole('link', { name: '查看素材来源' })
  expect(source.getAttribute('rel')).toBe('noopener noreferrer')
  expect(screen.getByRole('link', { name: 'Pexels License' }).getAttribute('href')).toBe('https://www.pexels.com/license/')
  fireEvent.click(screen.getByRole('button', { name: '下载到项目' }))
  await waitFor(() => expect(start).toHaveBeenCalledWith(9, 3, 'pexels_video', { query: '海洋', media_type: 'video', count: 8, download: true, index: 0, selected_id: 'ocean-9' }, 42))
})
it('presents discovery candidates as source pages without download actions', async () => {
  vi.mocked(toolboxApi.list).mockResolvedValue([{ ...job, result: { data: { discoveryOnly: true, candidates: [{ title: '海洋资料页面', pageUrl: 'https://example.org/ocean', excerpt: '原始网页摘要', downloadUrl: 'https://example.org/video.mp4', kind: 'video' }] } } }])
  mount()
  await screen.findByRole('heading', { name: '海洋资料页面' })
  expect(screen.getByText('原始网页摘要')).toBeTruthy()
  expect(screen.getByRole('link', { name: '查看来源页面' }).getAttribute('href')).toBe('https://example.org/ocean')
  expect(screen.queryByRole('button', { name: '下载到项目' })).toBeNull()
  expect(screen.getByText('查看结果数据')).toBeTruthy()
})
it('rejects untrusted thumbnails and active candidate links while preserving escaped text', async () => {
  const stock: ToolboxDefinition = { ...remoteTool, id: 'pexels_video', serviceType: 'stock', provider: 'pexels' }
  vi.mocked(toolboxApi.catalog).mockResolvedValue({ tools: [stock], providers: [] })
  vi.mocked(toolboxApi.list).mockResolvedValue([{ ...job, toolId: stock.id, result: { data: { provider: 'pexels', candidates: [{ id: 'bad', title: '<script>bad()</script>', preview: 'https://images.pexels.com.evil.test/tracker.jpg', url: 'javascript:alert(1)', author: '<img src=x onerror=bad()>', authorUrl: 'data:text/html,<script>bad()</script>', license: '自述许可', licenseUrl: 'javascript:bad()', downloadUrl: 'data:video/mp4,unsafe', kind: 'video' }] } } }])
  mount()
  await screen.findByRole('heading', { name: '<script>bad()</script>' })
  expect(screen.getByText('<img src=x onerror=bad()>')).toBeTruthy()
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.queryByRole('button', { name: '下载到项目' })).toBeNull()
  expect(document.querySelector('a[href^="javascript:"],a[href^="data:"],script,img[onerror]')).toBeNull()
})
it('disables candidate downloading while project edits are unsaved', async () => {
  const stock: ToolboxDefinition = { ...remoteTool, id: 'pexels_video', serviceType: 'stock', provider: 'pexels' }
  vi.mocked(toolboxApi.catalog).mockResolvedValue({ tools: [stock], providers: [] })
  vi.mocked(toolboxApi.list).mockResolvedValue([{ ...job, toolId: stock.id, result: { data: { provider: 'pexels', items: [{ id: '9', title: '海浪', downloadUrl: 'https://videos.pexels.com/9.mp4', kind: 'video' }] } } }])
  mount(false)
  expect((await screen.findByRole('button', { name: '下载到项目' }) as HTMLButtonElement).disabled).toBe(true)
})
it('requires explicit confirmation before resubmitting an uncertain task', async () => {
  vi.mocked(toolboxApi.list).mockResolvedValue([{ ...job, status: 'uncertain', result: null }])
  const resume = vi.spyOn(toolboxApi, 'resume').mockResolvedValue(job)
  mount()
  fireEvent.click(await screen.findByRole('button', { name: '重新提交任务' }))
  expect(resume).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog').textContent).toContain('再次提交可能重复计费')
  fireEvent.click(screen.getByRole('button', { name: '确认重新提交' }))
  await waitFor(() => expect(resume).toHaveBeenCalledWith(9, 17, undefined, true))
})
it('separates querying the original failed task from explicitly resubmitting it', async () => {
  vi.mocked(toolboxApi.list).mockResolvedValue([{ ...job, status: 'failed', remoteId: 'old-remote', result: null }])
  const resume = vi.spyOn(toolboxApi, 'resume').mockResolvedValue(job)
  mount()
  fireEvent.click(await screen.findByRole('button', { name: '重新提交任务' }))
  expect(resume).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '确认重新提交' }))
  await waitFor(() => expect(resume).toHaveBeenCalledWith(9, 17, undefined, true))
})
it('retains explicit zero and false arguments while validating required fields', () => {
  expect(toolboxArguments({ ...localTool, inputs: [{ key: 'n', label: '数量', type: 'number', required: true }, { key: 'b', label: '启用', type: 'boolean', required: true }] }, { n: 0, b: false })).toEqual({ n: 0, b: false })
  expect(() => toolboxArguments(remoteTool, { prompt: ' ' })).toThrow('请填写音乐要求')
})
