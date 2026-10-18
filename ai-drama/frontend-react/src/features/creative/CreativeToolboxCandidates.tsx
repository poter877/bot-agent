import type { ToolboxDefinition } from '@/entities/creative/toolbox'
import { Button } from '@/shared/ui/button'

interface Candidate {
  index: number
  id?: string
  title: string
  pageUrl: string
  preview: string
  author: string
  authorUrl: string
  license: string
  licenseUrl: string
  excerpt: string
  duration?: number
  kind?: string
  downloadable: boolean
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown) => typeof value === 'string' ? value : ''
function webUrl(value: unknown, httpsOnly = false) {
  if (typeof value !== 'string' || !value.trim()) return ''
  for (const char of value) if (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) return ''
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || !httpsOnly && url.protocol === 'http:') && !url.username && !url.password ? url.href : ''
  } catch { return '' }
}
const previewDomains: Record<string, string[]> = {
  pexels: ['images.pexels.com'], pixabay: ['pixabay.com', 'pixabaycdn.com'],
  unsplash: ['images.unsplash.com', 'plus.unsplash.com'], nasa: ['nasa.gov'],
  wikimedia: ['upload.wikimedia.org'], archive_org: ['archive.org'], loc: ['loc.gov'],
}
function previewUrl(value: unknown, provider: string) {
  const safe = webUrl(value, true)
  if (!safe) return ''
  const host = new URL(safe).hostname.toLowerCase()
  return previewDomains[provider]?.some(domain => host === domain || host.endsWith(`.${domain}`)) ? safe : ''
}
function parseCandidates(data: unknown, tool?: ToolboxDefinition) {
  const result = record(data)
  const stockItems = Array.isArray(result.items) ? result.items : Array.isArray(result.candidates) ? result.candidates : []
  const stock = typeof result.provider === 'string' && result.discoveryOnly !== true && stockItems.length > 0 && tool?.serviceType === 'stock'
  const source = stock ? stockItems : Array.isArray(result.candidates) ? result.candidates : []
  const discovery = result.discoveryOnly === true || !stock
  const provider = text(result.provider) || tool?.provider || ''
  const items: Candidate[] = source.slice(0, 50).flatMap((value, index) => {
    const item = record(value)
    if (!Object.keys(item).length) return []
    const id = typeof item.id === 'string' || typeof item.id === 'number' ? String(item.id) : undefined
    const pageUrl = webUrl(item.pageUrl ?? item.url)
    const kind = text(item.kind)
    return [{
      index, id, title: text(item.title) || `候选 ${index + 1}`, pageUrl,
      preview: previewUrl(item.preview, provider), author: text(item.author), authorUrl: webUrl(item.authorUrl),
      license: text(item.license), licenseUrl: webUrl(item.licenseUrl), excerpt: text(item.excerpt ?? item.content),
      duration: typeof item.duration === 'number' && Number.isFinite(item.duration) && item.duration > 0 ? item.duration : undefined,
      kind, downloadable: !discovery && !!webUrl(item.downloadUrl, true) && ['image', 'video', 'audio'].includes(kind),
    }]
  })
  return { items, discovery }
}
export function CreativeToolboxCandidates({ data, tool, disabled, onDownload }: {
  data: unknown; tool?: ToolboxDefinition; disabled: boolean; onDownload: (index: number, id?: string) => void
}) {
  const { items, discovery } = parseCandidates(data, tool)
  if (!items.length) return null
  return <section aria-label={discovery ? '来源页面候选' : '素材候选'} className="space-y-3">
    <p className="text-xs leading-relaxed text-content-muted">{discovery ? '以下是来源网页。请前往来源页挑选实际素材，并核对文件与许可。' : '查看来源与许可后下载所选素材；下载完成后可将产物加入项目素材库。'}</p>
    <div className="grid gap-3 xl:grid-cols-2">{items.map(item => <article key={`${item.index}-${item.id ?? item.pageUrl}`} className="min-w-0 space-y-2 rounded-control border border-outline p-3">
      {item.preview && <img src={item.preview} alt={item.title} loading="lazy" decoding="async" referrerPolicy="no-referrer" className="max-h-44 w-full rounded-control object-contain" />}
      <h4 className="break-words text-sm font-semibold text-content-secondary">{item.title}</h4>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-content-muted">
        {item.kind && <span>{{ image: '图片', video: '视频', audio: '音频' }[item.kind] ?? item.kind}</span>}
        {item.duration && <span>{item.duration} 秒</span>}
        {item.author && (item.authorUrl ? <a href={item.authorUrl} target="_blank" rel="noopener noreferrer" className="underline">{item.author}</a> : <span>{item.author}</span>)}
      </div>
      {item.excerpt && <p className="line-clamp-4 whitespace-pre-wrap break-words text-xs leading-relaxed text-content-muted">{item.excerpt}</p>}
      {(item.license || item.licenseUrl) && <p className="break-words text-xs text-content-muted">许可：{item.licenseUrl ? <a href={item.licenseUrl} target="_blank" rel="noopener noreferrer" className="text-brand-content underline">{item.license || '查看许可'}</a> : item.license}</p>}
      <div className="flex flex-wrap items-center gap-3">
        {item.pageUrl && <a href={item.pageUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-brand-content underline">{discovery ? '查看来源页面' : '查看素材来源'}</a>}
        {item.downloadable && <Button size="sm" disabled={disabled} onClick={() => onDownload(item.index, item.id)}>下载到项目</Button>}
        {!discovery && !item.downloadable && <span className="text-xs text-content-subtle">请到来源页面查看可下载文件</span>}
      </div>
    </article>)}</div>
  </section>
}
