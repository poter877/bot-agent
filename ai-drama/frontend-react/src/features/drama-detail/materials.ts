/**
 * 素材库数据组装：以项目内嵌 characters/scenes/props 三表为源（后端生图会写回其 imageUrl），
 * 附加显示分组与统一媒体字段。纯函数，便于契约测试。
 */
import type { Drama } from '@/entities/drama/model'
import type { AssetKind } from '@/entities/asset/model'

export interface Material {
  kindKey: AssetKind
  /** 显示分组名（渲染时由调用方以当前语言求值后传入） */
  kind: string
  id: number
  name: string
  image: string
  finalPrompt: string
  createdAt: string
  updatedAt: string
  character?: {
    role: string
    appearance: string
    styling: string
    description: string
  }
  scene?: {
    location: string
    time: string
    prompt: string
    lighting: string
  }
  prop?: {
    type: string
    description: string
  }
}

const KIND_ORDER: Record<AssetKind, number> = { character: 0, scene: 1, prop: 2 }

/** 图片相对路径（static/...）→ 展示地址；远程/绝对地址原样 */
export function assetSrcOf(image: string): string {
  if (!image) return ''
  return /^https?:\/\//i.test(image) || image.startsWith('/') ? image : `/${image}`
}

export function materialImage(m: { image: string }): string {
  return m.image || ''
}

export function buildMaterials(
  drama: Pick<Drama, 'characters' | 'scenes' | 'props'>,
  kindLabels: Record<AssetKind, string>,
): Material[] {
  const list: Material[] = []
  for (const c of drama.characters) {
    list.push({
      kindKey: 'character',
      kind: kindLabels.character,
      id: c.id,
      name: c.name,
      image: c.imageUrl || c.localPath || '',
      finalPrompt: c.finalPrompt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      character: { role: c.role, appearance: c.appearance, styling: c.styling, description: c.description },
    })
  }
  for (const s of drama.scenes) {
    list.push({
      kindKey: 'scene',
      kind: kindLabels.scene,
      id: s.id,
      name: s.location,
      image: s.imageUrl || s.localPath || '',
      finalPrompt: s.finalPrompt,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      scene: { location: s.location, time: s.time, prompt: s.prompt, lighting: s.lighting },
    })
  }
  for (const p of drama.props) {
    list.push({
      kindKey: 'prop',
      kind: kindLabels.prop,
      id: p.id,
      name: p.name,
      image: p.imageUrl || p.localPath || '',
      finalPrompt: p.finalPrompt,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      prop: { type: p.type, description: p.description },
    })
  }
  return list.sort((a, b) => KIND_ORDER[a.kindKey] - KIND_ORDER[b.kindKey] || a.id - b.id)
}

/** 素材描述文案（悬停 title 与卡片摘要） */
export function materialDesc(m: Material): string {
  if (m.kindKey === 'character') return m.character?.appearance || m.character?.description || ''
  if (m.kindKey === 'scene') return m.scene?.prompt || ''
  return m.prop?.description || ''
}

export function pendingKeyOf(kindKey: AssetKind, id: number): string {
  return `${kindKey}:${id}`
}
