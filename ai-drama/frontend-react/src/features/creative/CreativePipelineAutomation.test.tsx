// @vitest-environment jsdom
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { pipelineApi } from '@/entities/creative/pipeline'
import { toolboxApi } from '@/entities/creative/toolbox'
import { toCreativeDraft, type CreativeProject } from '@/entities/creative/model'
import { initI18n } from '@/shared/config/i18n'
import { parsePipelineAutomation } from '@/entities/creative/automation'
import { CreativePipelineAutomation } from './CreativePipelineAutomation'

const project: CreativeProject = {
  id: 42,
  title: '演示',
  category: 'screen_demo',
  style: '',
  aspectRatio: '16:9',
  revision: 3,
  approvedRevision: null,
  updatedAt: '',
  brief: { idea: '实际演示', audience: '', tone: '', language: 'zh', targetDuration: 30 },
  plan: { summary: '', script: '', musicDirection: '' },
  audio: { narrationUrl: null, musicUrl: null, musicVolume: 0.2, burnSubtitles: false },
  production: { fields: { steps: '操作步骤' }, sources: [] },
  shots: [],
  renders: [],
}
function mount(category = project.category) {
  const currentProject = { ...project, category }
  function Harness() {
    const [draft, setDraft] = useState(() => toCreativeDraft(currentProject))
    return (
      <>
        <CreativePipelineAutomation
          project={currentProject}
          draft={draft}
          disabled={false}
          onChange={setDraft}
        />
        <output data-testid="draft">{JSON.stringify(draft.production)}</output>
      </>
    )
  }
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <Harness />
    </QueryClientProvider>,
  )
}
function fields() {
  return JSON.parse(screen.getByTestId('draft').textContent!).fields
}
beforeEach(async () => {
  await initI18n().changeLanguage('zh')
  vi.spyOn(pipelineApi, 'toolPlan').mockResolvedValue({
    steps: [],
    policies: [
      {
        toolId: 'suno_music',
        mode: 'selectable',
        role: 'music',
        stages: ['assets'],
        categories: ['screen_demo'],
        purpose: '按脚本节奏生成配乐',
        selectionKey: 'music',
      },
      {
        toolId: 'audio_mix',
        mode: 'selectable',
        role: 'post',
        stages: ['edit'],
        categories: ['screen_demo'],
        purpose: '检查与调整音轨',
        selectionKey: 'postTools',
      },
      {
        toolId: 'not_for_this_pipeline',
        mode: 'selectable',
        role: 'music',
        stages: ['assets'],
        categories: ['cinematic'],
        purpose: '其他类型',
        selectionKey: 'music',
      },
    ],
  })
  vi.spyOn(toolboxApi, 'catalog').mockResolvedValue({
    tools: [
      {
        id: 'suno_music',
        name: '音乐制作',
        category: 'audio',
        provider: 'atlas',
        description: '',
        inputs: [],
        available: false,
        reason: '请配置音乐服务',
      },
      {
        id: 'audio_mix',
        name: '声音混合',
        category: 'audio',
        provider: 'local',
        description: '',
        inputs: [],
        available: true,
      },
    ],
    providers: [],
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('stores common selections in one automation field and retains the existing brief', async () => {
  mount()
  fireEvent.change(screen.getByLabelText('画面制作方式'), { target: { value: 'math' } })
  const music = await screen.findByLabelText('背景配乐')
  fireEvent.change(music, { target: { value: 'suno_music' } })
  fireEvent.click(screen.getByLabelText(/声音混合/))
  expect(fields().steps).toBe('操作步骤')
  expect(JSON.parse(fields().automation)).toEqual({
    visual: 'math',
    musicTool: 'suno_music',
    postTools: ['audio_mix'],
  })
  expect(screen.getAllByText(/请配置音乐服务/).length).toBeGreaterThan(0)
  expect(screen.queryByText('not_for_this_pipeline')).toBeNull()
  fireEvent.change(music, { target: { value: 'off' } })
  expect(JSON.parse(fields().automation).musicTool).toBe('off')
})

it('requires an explicit desktop capture choice and preserves invalid advanced edits for repair', () => {
  mount()
  const capture = screen.getByLabelText(/允许本轮流程录制当前桌面/)
  expect((capture as HTMLInputElement).checked).toBe(false)
  fireEvent.click(capture)
  expect(JSON.parse(fields().automation).capture).toBe(true)
  fireEvent.change(screen.getByLabelText('高级制作设置'), { target: { value: '{"visual":' } })
  expect(fields().automation).toBe('{"visual":')
  expect(screen.getByRole('alert').textContent).toContain('JSON 格式不正确')
  expect((screen.getByLabelText('画面制作方式').closest('fieldset') as HTMLFieldSetElement).disabled).toBe(
    true,
  )
  expect(parsePipelineAutomation(fields().automation).error).toBeTruthy()
})

it('selects avatar and transcription services using their workflow policy keys', async () => {
  vi.mocked(pipelineApi.toolPlan).mockResolvedValue({
    steps: [],
    policies: [
      {
        toolId: 'heygen_avatar',
        mode: 'selectable',
        role: 'visual',
        stages: ['assets'],
        categories: ['avatar'],
        purpose: '制作数字人画面；请补充头像和音色参数',
        selectionKey: 'avatar',
      },
      {
        toolId: 'whisper_transcribe',
        mode: 'selectable',
        role: 'analysis',
        stages: ['idea'],
        categories: ['avatar'],
        purpose: '为原片生成真实原稿与时码',
        selectionKey: 'transcription',
      },
    ],
  })
  vi.mocked(toolboxApi.catalog).mockResolvedValue({
    providers: [],
    tools: [
      {
        id: 'heygen_avatar',
        name: '数字人制作',
        provider: 'heygen',
        category: 'avatar',
        description: '',
        inputs: [],
        available: false,
        reason: '请配置数字人服务',
      },
      {
        id: 'whisper_transcribe',
        name: '原稿识别',
        provider: 'openai',
        category: 'speech',
        description: '',
        inputs: [],
        available: true,
      },
    ],
  })
  mount('avatar')
  fireEvent.change(await screen.findByLabelText('数字人 / 口型服务'), { target: { value: 'heygen_avatar' } })
  fireEvent.change(screen.getByLabelText('原稿识别服务'), { target: { value: 'whisper_transcribe' } })
  expect(JSON.parse(fields().automation)).toEqual({
    avatarTool: 'heygen_avatar',
    transcriptionTool: 'whisper_transcribe',
  })
  const value = {
    ...JSON.parse(fields().automation),
    toolParameters: { heygen_avatar: { avatar_id: 'saved-avatar', voice_id: 'saved-voice' } },
  }
  fireEvent.change(screen.getByLabelText('高级制作设置'), { target: { value: JSON.stringify(value) } })
  expect(JSON.parse(fields().automation).toolParameters.heygen_avatar).toEqual({
    avatar_id: 'saved-avatar',
    voice_id: 'saved-voice',
  })
})
