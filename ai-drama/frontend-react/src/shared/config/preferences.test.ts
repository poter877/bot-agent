/** 偏好存储迁移测试：旧前端逐键格式 → 新 prefs:v1 JSON（损坏数据回退默认值） */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { seedFromLegacy } from './preferences'

// 极简 localStorage 桩（node 环境无 localStorage）
class LocalStorageStub {
  private map = new Map<string, string>()
  getItem(k: string) {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.map.set(k, v)
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null
  }
  get length() {
    return this.map.size
  }
}

describe('seedFromLegacy', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new LocalStorageStub())
  })

  it('从旧键合成偏好快照（含 panel 记忆与 legacy 模型键）', () => {
    localStorage.setItem('huobao:theme', 'dark')
    localStorage.setItem('huobao:locale', 'ja')
    localStorage.setItem('huobao:sidebar-collapsed', '1')
    localStorage.setItem('huobao:workbench:video-cols', JSON.stringify({ left: 300, right: 400 }))
    localStorage.setItem('huobao:model:rewrite', 'volcengine/seedance-2') // legacy chat 键
    localStorage.setItem('huobao:model:image', 'openai/gpt-image-2')
    localStorage.setItem('huobao:workbench:panel:7:2', JSON.stringify({ panel: 'production', scriptStep: 1, prodTab: 'videos' }))

    const seeded = seedFromLegacy()!
    expect(seeded.themeMode).toBe('dark')
    expect(seeded.uiLocale).toBe('ja')
    expect(seeded.sidebarCollapsed).toBe(true)
    expect(seeded.videoColumns).toEqual({ left: 300, right: 400 })
    expect(seeded.modelPrefs!.chat).toBe('volcengine/seedance-2')
    expect(seeded.modelPrefs!.image).toBe('openai/gpt-image-2')
    expect(seeded.panels!['7:2']).toEqual({ panel: 'production', scriptStep: 1, prodTab: 'videos' })
  })

  it('非法值回退默认（损坏 JSON、未知主题/语言被忽略）', () => {
    localStorage.setItem('huobao:theme', 'blue')
    localStorage.setItem('huobao:locale', 'fr')
    localStorage.setItem('huobao:workbench:video-cols', '{broken')
    localStorage.setItem('huobao:workbench:panel:1:1', '{broken')

    const seeded = seedFromLegacy()!
    expect(seeded.themeMode).toBeUndefined()
    expect(seeded.uiLocale).toBeUndefined()
    expect(seeded.videoColumns).toBeUndefined()
    expect(seeded.panels).toEqual({})
  })

  it('无任何旧键时返回空种子（全部走默认值）', () => {
    const seeded = seedFromLegacy()!
    expect(seeded.panels).toEqual({})
    expect(seeded.modelPrefs).toEqual({ chat: '', image: '', video: '' })
  })
})
