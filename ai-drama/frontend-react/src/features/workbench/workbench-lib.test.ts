/** 工作台纯函数契约测试：模型选项归属、参考图序号映射、任务状态机、栏宽钳制 */
import { describe, expect, it } from 'vitest'
import type { AiConfig } from '@/entities/ai-config/model'
import type { Character, Prop, Scene } from '@/entities/asset/model'
import type { Storyboard } from '@/entities/storyboard/model'
import {
  bareModelName,
  clampVideoCol,
  collectModelOptions,
  configModels,
  getShotReferenceImages,
  hasMultiConfigs,
  isNarratorCharacter,
  ownerConfigId,
  pruneStaleModel,
  resolveVideoPromptRefs,
  getShotReferenceIndexMap,
  videoTaskStateOf,
} from './workbench-lib'

function cfg(partial: Partial<AiConfig>): AiConfig {
  return {
    id: 1,
    serviceType: 'video',
    provider: 'volcengine',
    name: 'cfg',
    baseUrl: '',
    apiKey: '',
    models: [],
    endpoint: '',
    queryEndpoint: '',
    priority: 0,
    isDefault: false,
    isActive: true,
    temperature: null,
    createdAt: '',
    updatedAt: '',
    ...partial,
  }
}

describe('collectModelOptions', () => {
  it('按优先级排序、只含启用配置', () => {
    const configs = [
      cfg({ id: 1, provider: 'volcengine', models: ['seedance-2', 'seedance-mini'], priority: 10, isActive: true }),
      cfg({ id: 2, provider: 'volcengine', models: ['seedance-2'], priority: 5, isActive: true }),
      cfg({ id: 3, provider: 'aliyun', models: ['wan3.0-video'], priority: 20, isActive: false }),
    ]
    const options = collectModelOptions(configs)
    expect(options.map((o) => o.key)).toEqual(['1:seedance-2', '1:seedance-mini', '2:seedance-2'])
    expect(options[0]).toMatchObject({ configId: 1, provider: 'volcengine' })
  })

  it('同名模型来自不同配置时键可区分（修正旧版 provider/model 去重合并），保留旧键供迁移', () => {
    const configs = [
      cfg({ id: 1, provider: 'openai', name: '中转站', models: ['deepseek-v4'], priority: 10 }),
      cfg({ id: 2, provider: 'openai', name: '官方', models: ['deepseek-v4'], priority: 5 }),
    ]
    const options = collectModelOptions(configs)
    expect(options).toHaveLength(2)
    expect(options.map((o) => o.key)).toEqual(['1:deepseek-v4', '2:deepseek-v4'])
    expect(options.map((o) => o.legacyKey)).toEqual(['openai/deepseek-v4', 'openai/deepseek-v4'])
    expect(options[0]!.configId).toBe(1)
    expect(hasMultiConfigs(options)).toBe(true)
  })
})

describe('bareModelName / ownerConfigId', () => {
  it('复合键取裸模型名；提交时带正确 config_id', () => {
    expect(bareModelName('1:deepseek-v4'.replace(/^\d+:/, ''))).toBe('deepseek-v4')
    expect(bareModelName('openai/deepseek-v4')).toBe('deepseek-v4')
    expect(bareModelName('')).toBe('')
    const options = collectModelOptions([cfg({ id: 7, provider: 'openai', models: ['deepseek-v4'] })])
    expect(ownerConfigId(options, '7:deepseek-v4')).toBe(7)
    expect(ownerConfigId(options, '')).toBeUndefined()
    expect(ownerConfigId(options, '7:none')).toBeUndefined()
  })
})

describe('pruneStaleModel', () => {
  const options = collectModelOptions([cfg({ id: 1, provider: 'openai', models: ['deepseek-v4'] })])
  it('新键有效保持不变', () => {
    expect(pruneStaleModel('1:deepseek-v4', options)).toBe('1:deepseek-v4')
  })
  it('旧 provider/model 复合键与裸模型名均可升级', () => {
    expect(pruneStaleModel('openai/deepseek-v4', options)).toBe('1:deepseek-v4')
    expect(pruneStaleModel('deepseek-v4', options)).toBe('1:deepseek-v4')
  })
  it('失效选择回退默认', () => {
    expect(pruneStaleModel('openai/gone', options)).toBe('')
  })
})

describe('configModels', () => {
  it('模型字段为数组/字符串两种历史形态时都归一为数组', () => {
    expect(configModels({ models: ['a', 'b'] } as AiConfig)).toEqual(['a', 'b'])
    expect(configModels(null)).toEqual([])
  })
})

function char(id: number, name: string, imageUrl = ''): Character {
  return {
    id, dramaId: 1, name, role: '', description: '', appearance: '', styling: '',
    finalPrompt: '', personality: '', imageUrl, referenceImages: '', seedValue: null,
    sortOrder: 0, localPath: '', createdAt: '', updatedAt: '',
  }
}
function scene(id: number, location: string, imageUrl = ''): Scene {
  return {
    id, dramaId: 1, episodeId: 1, location, time: '', prompt: '', lighting: '',
    finalPrompt: '', storyboardCount: 0, imageUrl, status: 'pending', localPath: '',
    createdAt: '', updatedAt: '',
  }
}
function prop(id: number, name: string, imageUrl = ''): Prop {
  return {
    id, dramaId: 1, name, type: '', description: '', prompt: '', finalPrompt: '',
    imageUrl, referenceImages: '', localPath: '', createdAt: '', updatedAt: '',
  }
}
function sb(partial: Partial<Storyboard>): Storyboard {
  return {
    id: 1, episodeId: 1, sceneId: null, storyboardNumber: 1, title: '', location: '', time: '',
    shotType: '', angle: '', movement: '', result: '', atmosphere: '', imagePrompt: '',
    videoPrompt: '', bgmPrompt: '', soundEffect: '', description: '', duration: 10,
    composedImage: '', firstFrameImage: '', lastFrameImage: '', referenceImages: '',
    videoUrl: '', subtitleUrl: '', composedVideoUrl: '', status: 'pending',
    characterIds: [], propIds: [], characters: [], props: [], createdAt: '', updatedAt: '',
    ...partial,
  }
}

describe('参考图序号映射（@名字 → @图片N）', () => {
  const chars = [char(1, '小美', 'static/images/a.png'), char(2, '阿强', 'static/images/b.png')]
  const scenes = [scene(10, '咖啡馆', 'static/images/cafe.png')]
  const props = [prop(20, '怀表', 'static/images/watch.png')]

  it('顺序为 场景→角色→道具，序号 1 起，无图不占位', () => {
    const noImageChars = [char(3, '无图角色')]
    const board2 = sb({ sceneId: 10, characterIds: [1, 3], propIds: [] })
    const map = getShotReferenceIndexMap(board2, [...chars, ...noImageChars], scenes, props, 9)
    expect(map).toEqual({ 咖啡馆: 1, 小美: 2 })
  })

  it('提交生成时的参考图列表去重且受上限约束', () => {
    const board = sb({ sceneId: 10, characterIds: [1, 2], propIds: [20] })
    expect(getShotReferenceImages(board, chars, scenes, props, 9)).toEqual([
      'static/images/cafe.png',
      'static/images/a.png',
      'static/images/b.png',
      'static/images/watch.png',
    ])
    expect(getShotReferenceImages(board, chars, scenes, props, 2)).toEqual([
      'static/images/cafe.png',
      'static/images/a.png',
    ])
  })

  it('@名字 按参考图序号替换为 @图片N名字（最长名优先）', () => {
    const board = sb({
      sceneId: 10,
      characterIds: [1, 2],
      propIds: [20],
      videoPrompt: '@小美 推门进入 @咖啡馆，@阿强 在角落把玩 @怀表',
    })
    const resolved = resolveVideoPromptRefs(board, chars, scenes, props, 9)
    expect(resolved).toBe('@图片2小美 推门进入 @图片1咖啡馆，@图片3阿强 在角落把玩 @图片4怀表')
  })
})

describe('videoTaskStateOf', () => {
  it('done 优先于 pending/failed', () => {
    const board = sb({ videoUrl: 'static/videos/x.mp4' })
    expect(videoTaskStateOf(board, () => true, () => 'err')).toBe('done')
    expect(videoTaskStateOf(sb({}), () => true, () => '')).toBe('pending')
    expect(videoTaskStateOf(sb({}), () => false, () => '上游错误')).toBe('failed')
    expect(videoTaskStateOf(sb({}), () => false, () => '')).toBe('ready')
    expect(videoTaskStateOf(null, () => true, () => 'x')).toBe('ready')
  })
})

describe('isNarratorCharacter', () => {
  it('按多语言关键词识别旁白', () => {
    expect(isNarratorCharacter(char(1, '旁白'))).toBe(true)
    expect(isNarratorCharacter({ ...char(2, 'Voice'), role: 'narrator' })).toBe(true)
    expect(isNarratorCharacter(char(3, 'ナレーター'))).toBe(true)
    expect(isNarratorCharacter(char(4, '小美'))).toBe(false)
  })
})

describe('clampVideoCol', () => {
  it('栏宽钳制在 180-420 / 260-560', () => {
    expect(clampVideoCol('left', 100)).toBe(180)
    expect(clampVideoCol('left', 999)).toBe(420)
    expect(clampVideoCol('right', 100)).toBe(260)
    expect(clampVideoCol('right', 999)).toBe(560)
  })
})
