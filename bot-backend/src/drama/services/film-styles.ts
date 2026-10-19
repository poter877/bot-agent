/** 影片风格注册表：43 种 Lemo-Opuscar 风格的元数据、STYLE.md 约束与渲染档位。
 *
 * 数据来源 backend/workspace/film-styles/（index.json + <slug>/STYLE.md），
 * 指南（DIRECTOR/TECHNIQUE/AGENTS）在 _guides/。原始库 MIT 协议，
 * 作者 Lemomo（lemomo-ai/lemo-opuscar）；样片内容不随注册表分发。
 *
 * renderProfile 从 STYLE.md 内容判定（三档）：
 *   3d     — three.js 3D 场景（需 GPU）
 *   shader — Canvas2D 之上叠 WebGL2 后期（CRT/胶片损伤/着色器）
 *   2d     — 纯 Canvas 2D
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const STYLES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../workspace/film-styles')

export interface FilmStyleMeta {
  slug: string
  num: string
  en: string
  cn: string
  category_en: string
  category_cn: string
  film: string
  line: string
  line_cn: string
  uses: string[]
  frame_sec: number
  dur: number
}

export type RenderProfile = '2d' | 'shader' | '3d'

export interface FilmStyle extends FilmStyleMeta {
  renderProfile: RenderProfile
}

let cache: FilmStyle[] | null = null

function readStyleMd(slug: string): string {
  try {
    return fs.readFileSync(path.join(STYLES_ROOT, slug, 'STYLE.md'), 'utf8')
  } catch {
    return ''
  }
}

export function filmStyleMarkdown(slug: string): string {
  const md = readStyleMd(slug)
  if (!md) throw new Error(`film style not found: ${slug}`)
  return md
}

function classifyRender(md: string): RenderProfile {
  if (/\bthree\.js\b|perspective camera|depth of field|GTAO/i.test(md)) return '3d'
  if (/WebGL2|shader|GLSL/i.test(md)) return 'shader'
  return '2d'
}

export function filmStyles(): FilmStyle[] {
  if (cache) return cache
  const index = JSON.parse(fs.readFileSync(path.join(STYLES_ROOT, 'index.json'), 'utf8')) as FilmStyleMeta[]
  cache = index.map((meta) => ({ ...meta, renderProfile: classifyRender(readStyleMd(meta.slug)) }))
  return cache
}

export function getFilmStyle(slug: string): FilmStyle | null {
  return filmStyles().find((s) => s.slug === slug) ?? null
}

/** 风格分组（按 category_cn 保序） */
export function filmStyleGroups(): Array<{ key: string; cn: string; en: string; styles: FilmStyle[] }> {
  const groups: Array<{ key: string; cn: string; en: string; styles: FilmStyle[] }> = []
  for (const s of filmStyles()) {
    let g = groups.find((x) => x.cn === s.category_cn)
    if (!g) {
      g = { key: s.category_en, cn: s.category_cn, en: s.category_en, styles: [] }
      groups.push(g)
    }
    g.styles.push(s)
  }
  return groups
}

export interface FilmGuides {
  director: string
  technique: string
  agents: string
}

export function filmGuides(): FilmGuides {
  const read = (name: string) => {
    try {
      return fs.readFileSync(path.join(STYLES_ROOT, '_guides', name), 'utf8')
    } catch {
      return ''
    }
  }
  return { director: read('DIRECTOR.md'), technique: read('TECHNIQUE.md'), agents: read('AGENTS.md') }
}
