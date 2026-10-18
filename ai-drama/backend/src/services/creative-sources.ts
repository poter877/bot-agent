import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CreativeError, creativeShotSchema } from './creative-model.js'
import type { CreativeProject } from './creative-projects.js'

export const sourceSelectionSchema = z.object({ start: z.number().finite().min(0), end: z.number().finite().positive(), title: z.string().trim().min(1).max(200), caption: z.string().max(3000).default('') })
/** Convert SRT to timed ranges; source time remains intact until the user chooses how to edit it. */
export function parseCreativeSrt(text: string) {
  if (text.length > 100000) throw new CreativeError('字幕文件不能超过 100000 个字符')
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r/g, '').trim().split(/\n\s*\n/)
  const time = (value: string) => {
    const parts = value.replace(',', '.').split(':').map(Number)
    if (parts.some(value => !Number.isFinite(value)) || parts[1] >= 60 || parts[2] >= 60) throw new CreativeError('字幕时间格式无效')
    return parts[0] * 3600 + parts[1] * 60 + parts[2]
  }
  let previous = 0
  return blocks.map((block, index) => {
    const lines = block.split('\n')
    const line = lines.findIndex(s => s.includes('-->'))
    const match = lines[line]?.match(/^(\d{2,}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2,}:\d{2}:\d{2}[,.]\d{3})\s*$/)
    if (!match) throw new CreativeError(`第 ${index + 1} 条字幕时码无效`)
    const start = time(match[1]), end = time(match[2])
    if (start < previous || end <= start || end - start > 600) throw new CreativeError(`第 ${index + 1} 条字幕时码重叠或长度无效`)
    previous = end
    const caption = lines.slice(line + 1).join('\n').replace(/<[^>]*>/g, '').trim()
    if (!caption || caption.length > 3000) throw new CreativeError(`第 ${index + 1} 条字幕内容无效`)
    return { start, end, title: `字幕 ${index + 1}`, caption }
  })
}

export function sourceSelectionsToShots(project: CreativeProject, sourceId: string, selections: z.infer<typeof sourceSelectionSchema>[], preserveGaps = false) {
  const source = project.production.sources.find(item => item.id === sourceId)
  if (!source) throw new CreativeError('素材不存在', 404)
  if (source.kind === 'image' || !source.duration) throw new CreativeError('请选择有时长的视频或音频')
  if (!selections.length || selections.length > 200) throw new CreativeError('请选择 1 至 200 个片段')
  const ranges = selections.map(range => {
    const parsed = sourceSelectionSchema.parse(range)
    return preserveGaps ? { ...parsed, start: Math.round(parsed.start * 30) / 30, end: Math.round(parsed.end * 30) / 30 } : parsed
  })
  const expanded: typeof ranges = []
  let cursor = 0
  for (const range of ranges) {
    if (range.end <= range.start || range.end > source.duration + 0.04 || range.end - range.start > 600) throw new CreativeError('片段起止时间无效、超出原片或单段超过 600 秒')
    if (preserveGaps) {
      if (range.start < cursor) throw new CreativeError('字幕时序不能重叠')
      while (range.start - cursor >= 1 / 30) {
        const end = Math.min(cursor + 600, range.start)
        expanded.push({ start: cursor, end, title: '原片过渡', caption: '' }); cursor = end
      }
    }
    expanded.push(range); cursor = range.end
  }
  if (preserveGaps) {
    while (source.duration - cursor >= 1 / 30) {
      const end = Math.min(cursor + 600, source.duration)
      expanded.push({ start: cursor, end, title: '原片收尾', caption: '' }); cursor = end
    }
  }
  if (expanded.length > 200 || expanded.reduce((sum, range) => sum + range.end - range.start, 0) > 3600) throw new CreativeError('编排超过 200 个画面或 60 分钟，请拆分为多个项目')
  return expanded.map(range => creativeShotSchema.parse({
    id: randomUUID(), title: range.title, duration: range.end - range.start,
    visualPrompt: `使用素材「${source.name}」的 ${range.start} 至 ${range.end} 秒`, narration: '', caption: range.caption,
    mediaType: source.kind === 'video' ? 'video' : 'image', imageUrl: source.coverUrl, videoUrl: source.kind === 'video' ? source.url : null,
    audioUrl: source.kind === 'audio' ? source.url : null, audioTrimStart: range.start, trimStart: range.start,
    imageTaskId: null, videoTaskId: null, originalVolume: 1,
  }))
}
