/** cn 合并语义契约：自定义字号/圆角/阴影/品牌渐变不被误删，冲突组正确互斥 */
import { describe, expect, it } from 'vitest'
import { cn } from './cn'

describe('cn（tailwind-merge 自定义分组）', () => {
  it('字号 token 与颜色 token 属不同分组，同时保留', () => {
    const out = cn('text-ui text-content')
    expect(out).toContain('text-ui')
    expect(out).toContain('text-content')
  })

  it('同类互斥：后者覆盖前者', () => {
    expect(cn('text-ui text-caption')).toBe('text-caption')
    expect(cn('bg-surface bg-app')).toBe('bg-app')
    expect(cn('rounded-panel rounded-pill')).toBe('rounded-pill')
    expect(cn('shadow-card shadow-focus')).toBe('shadow-focus')
  })

  it('bg-brand-gradient 与 bg 颜色不互删（背景图 vs 背景色可并存）', () => {
    const out = cn('bg-brand-gradient text-on-action')
    expect(out).toContain('bg-brand-gradient')
    expect(out).toContain('text-on-action')
  })

  it('普通 Tailwind 类照常合并', () => {
    expect(cn('px-2 px-4', 'flex items-center', 'items-center')).toBe('px-4 flex items-center')
  })

  it('状态 variants 前缀类保留（hover:/focus-visible:/disabled:）', () => {
    const out = cn('hover:bg-button-hover hover:bg-brand-soft')
    expect(out).toBe('hover:bg-brand-soft')
  })
})
