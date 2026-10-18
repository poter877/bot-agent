/** DTO mapper 契约测试：snake/camel 双形态、JSON 字符串数组、envelope 语义 */
import { describe, expect, it } from 'vitest'
import { parseJsonArray } from '@/shared/api/dto'
import { mapSysTask, mapVideoMerge } from '@/entities/generation-task/model'
import { mapAiConfig } from '@/entities/ai-config/model'
import { mapStoryboard } from '@/entities/storyboard/model'
import { buildMaterials } from '@/features/drama-detail/materials'

describe('parseJsonArray', () => {
  it('解析 JSON 字符串数组；解析失败回退空数组', () => {
    expect(parseJsonArray('["3d","anime"]')).toEqual(['3d', 'anime'])
    expect(parseJsonArray(['a'])).toEqual(['a'])
    expect(parseJsonArray('not-json')).toEqual([])
    expect(parseJsonArray(null)).toEqual([])
  })
})

describe('mapSysTask（/tasks 系列为 camelCase 原始行）', () => {
  it('保留 camelCase 字段', () => {
    const row = {
      id: 9,
      type: 'video',
      storyboardId: 3,
      status: 'completed',
      resultUrl: 'https://cdn/x.mp4',
      localPath: 'static/videos/x.mp4',
      errorMsg: '',
      createdAt: '2026-01-01T00:00:00Z',
    }
    const task = mapSysTask(row)
    expect(task.storyboardId).toBe(3)
    expect(task.localPath).toBe('static/videos/x.mp4')
    expect(task.status).toBe('completed')
  })
})

describe('mapVideoMerge（snake_case 行；scenes 为 JSON 字符串）', () => {
  it('解析 merged_url 与 scenes 源列表', () => {
    const row = {
      id: 5,
      episode_id: 2,
      status: 'completed',
      scenes: '["static/videos/a.mp4","static/videos/b.mp4"]',
      merged_url: 'static/merged/x.mp4',
      duration: 30,
    }
    const merge = mapVideoMerge(row)
    expect(merge.mergedUrl).toBe('static/merged/x.mp4')
    expect(merge.sources).toHaveLength(2)
    expect(merge.duration).toBe(30)
  })
})

describe('mapAiConfig（model 字段数组/JSON 字符串归一）', () => {
  it('JSON 字符串解析为模型数组', () => {
    const cfg = mapAiConfig({ id: 1, service_type: 'text', provider: 'openai', model: '["gpt-x"]', is_active: 1 })
    expect(cfg.models).toEqual(['gpt-x'])
    expect(cfg.isActive).toBe(true)
  })
})

describe('mapStoryboard（关联资产与 id 数组内嵌）', () => {
  it('character_ids/prop_ids 归一为 number[]', () => {
    const row = {
      id: 4,
      episode_id: 2,
      storyboard_number: 3,
      duration: 8,
      character_ids: [1, 2],
      prop_ids: ['5'],
      characters: [],
      props: [],
    }
    const board = mapStoryboard(row)
    expect(board.characterIds).toEqual([1, 2])
    expect(board.propIds).toEqual([5])
    expect(board.duration).toBe(8)
  })
})

describe('buildMaterials（素材库分组排序：角色→场景→道具）', () => {
  it('按类型分组且组内按 id 排序', () => {
    const materials = buildMaterials(
      {
        characters: [{ ...charFixture(2, 'B') }, { ...charFixture(1, 'A') }],
        scenes: [],
        props: [{ ...propFixture(9) }],
      },
      { character: '角色', scene: '场景', prop: '道具' },
    )
    expect(materials.map((m) => `${m.kindKey}:${m.id}`)).toEqual(['character:1', 'character:2', 'prop:9'])
  })
})

function charFixture(id: number, name: string) {
  return {
    id, dramaId: 1, name, role: '', description: '', appearance: '', styling: '',
    finalPrompt: '', personality: '', imageUrl: '', referenceImages: '', seedValue: null,
    sortOrder: 0, localPath: '', createdAt: '', updatedAt: '',
  }
}
function propFixture(id: number) {
  return {
    id, dramaId: 1, name: 'P', type: '', description: '', prompt: '', finalPrompt: '',
    imageUrl: '', referenceImages: '', localPath: '', createdAt: '', updatedAt: '',
  }
}
