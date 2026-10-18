import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Search, Settings2, Wrench } from 'lucide-react'
import { aiConfigApi } from '@/entities/ai-config/model'
import { toolQueries } from '@/entities/creative/tools'
import { type CreativeProject } from '@/entities/creative/model'
import { toolboxApi, toolboxArguments, toolboxDefaults, toolboxQueries, type ToolboxDefinition, type ToolboxFile, type ToolboxInput, type ToolboxJob } from '@/entities/creative/toolbox'
import { qk } from '@/shared/api/query-keys'
import { cn } from '@/shared/lib/cn'
import { Button } from '@/shared/ui/button'
import { Input, Textarea } from '@/shared/ui/input'
import { BaseSelect } from '@/shared/ui/BaseSelect'
import { Modal } from '@/shared/ui/Modal'
import { CreativeSection, MediaUpload } from './CreativeFields'
import { CreativeProductionFiles } from './CreativeProductionFiles'
import { CreativeToolboxCandidates } from './CreativeToolboxCandidates'

type Draft = { args: Record<string, unknown>; configId: string }
const activeStatus = (status: ToolboxJob['status']) => status === 'queued' || status === 'running'
const statusLabels: Record<ToolboxJob['status'], string> = {
  queued: '等待执行', running: '正在执行', completed: '已完成', failed: '执行失败', uncertain: '需要恢复查询', cancelled: '已停止',
}
const categoryLabels: Record<string, string> = {
  audio: '声音制作', image: '图像制作', video: '视频制作', editing: '剪辑与合成',
  generation: '内容生成', research: '联网取材', stock: '素材搜索', animation: '动画制作',
  '3d': '三维制作', graphics: '图形与动画', analysis: '分析与检查', subtitles: '字幕与翻译', character: '角色与动作',
  avatar: '数字人', capture: '录制与采集', enhancement: '画质与音质增强', publishers: '导出与发布', subtitle: '字幕与翻译',
}
function categoryLabel(value: string) { return categoryLabels[value] ?? value }
function isMediaCollection(field: ToolboxInput) {
  return field.type === 'json' && /(?:urls|images)$/i.test(field.key)
}
function mediaCollectionValue(value: unknown): string[] {
  const items: unknown = typeof value === 'string' ? value.trim() ? JSON.parse(value) : [] : value ?? []
  if (!Array.isArray(items) || items.some(item => typeof item !== 'string')) throw new Error('素材列表需要填写地址数组')
  return items
}
function sourceOptions(project: CreativeProject, accept?: string, outputs: ToolboxFile[] = []) {
  const items = [
    ...(project.production?.sources ?? []).map(source => ({ value: source.url, label: `素材 · ${source.name}`, kind: source.kind })),
    ...project.shots.flatMap(shot => [
      ...(shot.imageUrl ? [{ value: shot.imageUrl, label: `镜头图片 · ${shot.title}`, kind: 'image' }] : []),
      ...(shot.videoUrl ? [{ value: shot.videoUrl, label: `镜头视频 · ${shot.title}`, kind: 'video' }] : []),
      ...(shot.audioUrl ? [{ value: shot.audioUrl, label: `镜头配音 · ${shot.title}`, kind: 'audio' }] : []),
    ]),
    ...(project.audio.narrationUrl ? [{ value: project.audio.narrationUrl, label: '项目旁白', kind: 'audio' }] : []),
    ...(project.audio.musicUrl ? [{ value: project.audio.musicUrl, label: '项目配乐', kind: 'audio' }] : []),
    ...outputs.map(file => ({ value: file.url, label: `工具产物 · ${file.name}`, kind: file.kind })),
  ]
  const accepted = accept?.split(',').map(value => value.trim().toLowerCase()).filter(Boolean) ?? []
  return [...new Map(items.filter(item => !accepted.length || accepted.some(type => type.startsWith('.') ? item.value.split('?')[0].toLowerCase().endsWith(type) : type.startsWith(item.kind))).map(item => [item.value, item])).values()]
}
function Field({ field, value, project, outputs, disabled, uploadPending, onChange, onUpload }: {
  field: ToolboxInput; value: unknown; project: CreativeProject; disabled: boolean; uploadPending: boolean
  outputs: ToolboxFile[]
  onChange: (value: unknown) => void; onUpload: (file: File) => void
}) {
  const id = useId()
  const label = `${field.label}${field.required ? ' *' : ''}`
  const textValue = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  const media = field.type === 'media'
  const collection = isMediaCollection(field)
  const choices = media || collection ? sourceOptions(project, field.accept, outputs) : []
  let mediaValues: string[] | null = null
  if (collection) { try { mediaValues = mediaCollectionValue(value) } catch { /* Keep incomplete JSON available for correction. */ } }
  return <div className="min-w-0 space-y-2">
    {field.type === 'boolean' ? <label className="flex items-center gap-2 text-sm text-content-secondary">
      <input type="checkbox" checked={value === true} disabled={disabled} onChange={event => onChange(event.target.checked)} />{label}
    </label> : <>
      <label htmlFor={id} className="block text-xs font-semibold text-content-secondary">{label}</label>
      {field.key === 'shotId' ? <select id={id} value={textValue} disabled={disabled} onChange={event => onChange(event.target.value)} className="min-h-10 w-full rounded-control border border-outline bg-input px-3 text-sm text-content focus-visible:shadow-focus"><option value="">选择人物镜头</option>{project.shots.map(shot => <option value={shot.id} key={shot.id}>{shot.title} · {shot.duration}s{shot.audioUrl ? ' · 已有配音' : ''}</option>)}</select>
        : field.type === 'select' ? <select id={id} value={textValue} disabled={disabled} onChange={event => onChange(event.target.value)} className="min-h-10 w-full rounded-control border border-outline bg-input px-3 text-sm text-content focus-visible:shadow-focus">
        <option value="">请选择</option>
        {(field.options ?? []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select> : field.type === 'json' ? <Textarea id={id} value={textValue} disabled={disabled} rows={6} resize="vertical" spellCheck={false} onChange={event => onChange(event.target.value)} placeholder="填写 JSON 参数" className="font-mono text-xs" />
        : field.type === 'text' ? <Textarea id={id} value={textValue} disabled={disabled} rows={2} resize="vertical" onChange={event => onChange(event.target.value)} />
          : <Input id={id} value={textValue} disabled={disabled} type={field.type === 'number' ? 'number' : 'text'} step={field.type === 'number' ? 'any' : undefined} onChange={event => onChange(event.target.value)} placeholder={media ? '选择项目素材、上传文件，或填写素材地址' : undefined} />}
    </>}
    {media && <div className="flex flex-wrap items-start gap-2">
      {choices.length > 0 && <div className="min-w-[180px] flex-1"><BaseSelect value={textValue} onChange={onChange} options={choices} disabled={disabled} placeholder="从当前项目选择素材" /></div>}
      <MediaUpload accept={field.accept || 'image/*,video/*,audio/*,.glb,.json,.svg,.srt,.vtt,.txt'} label={`上传${field.label}`} disabled={disabled} loading={uploadPending} onFile={onUpload} />
    </div>}
    {collection && <div className="space-y-2 rounded-control border border-outline p-3">
      <p className="text-xs text-content-muted">从项目中多选素材；选择顺序就是制作顺序。</p>
      {mediaValues === null ? <p className="text-xs text-danger">请先修正上方 JSON，再从项目中选择素材。</p> : <div className="max-h-48 space-y-2 overflow-y-auto">{choices.map(option => <label key={option.value} className="flex items-start gap-2 break-words text-xs text-content-secondary"><input type="checkbox" className="mt-0.5" disabled={disabled} checked={mediaValues!.includes(option.value)} onChange={event => onChange(JSON.stringify(event.target.checked ? [...mediaValues!, option.value] : mediaValues!.filter(url => url !== option.value), null, 2))} />{option.label}</label>)}</div>}
      <MediaUpload accept={field.accept || 'image/*,video/*,audio/*,.glb,.json,.svg,.srt,.vtt,.txt'} label={`上传并加入${field.label}`} disabled={disabled || mediaValues === null} loading={uploadPending} onFile={onUpload} />
    </div>}
  </div>
}
function JobCard({ job, tool, project, canApply, pending, notice, onResume, onRetrySubmission, onCancel, onApply, onReuse, onStartCandidate }: {
  job: ToolboxJob; tool?: ToolboxDefinition; project: CreativeProject; canApply: boolean; pending: boolean
  notice?: { fileUrl?: string; message: string }
  onResume: (remoteId?: string) => void; onCancel: () => void
  onRetrySubmission: () => void
  onApply: (value: { fileUrl?: string; shotId?: string; sourceId?: string; sourceName?: string }) => void; onReuse: () => void
  onStartCandidate: (index: number, id?: string) => void
}) {
  const [remoteId, setRemoteId] = useState('')
  const [fileUrl, setFileUrl] = useState('')
  const [shotId, setShotId] = useState('')
  const [sourceName, setSourceName] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [retryConfirmation, setRetryConfirmation] = useState(false)
  const usableFiles = job.result?.files?.filter(file => ['image', 'video', 'audio', 'subtitle'].includes(file.kind) || file.kind === 'model' && /\.glb(?:$|\?)/i.test(file.url)) ?? []
  const selectedFile = usableFiles.find(file => file.url === fileUrl) ?? usableFiles[0]
  const sourceImported = !!selectedFile && project.production?.sources.some(source => source.url === selectedFile.url)
  const targetShot = project.shots.find(shot => shot.id === shotId)
  const appliedToShot = !!selectedFile && !!targetShot && (selectedFile.kind === 'image' ? targetShot.imageUrl : selectedFile.kind === 'video' ? targetShot.videoUrl : targetShot.audioUrl) === selectedFile.url
  return <article className="min-w-0 space-y-3 rounded-control border border-outline p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0"><h3 className="break-words text-sm font-semibold">{tool?.name ?? job.toolId}</h3><p className="mt-1 text-xs text-content-muted">任务 #{job.id} · {new Date(job.createdAt).toLocaleString()}</p></div>
      <span className={cn('rounded-pill px-2 py-1 text-xs', job.status === 'failed' || job.status === 'uncertain' ? 'bg-danger-soft text-danger' : 'bg-brand-soft text-brand-content')}>{statusLabels[job.status]}</span>
    </div>
    {activeStatus(job.status) && <div className="space-y-1"><progress aria-label="任务进度" value={Math.min(100, Math.max(0, job.progress))} max={100} className="h-2 w-full accent-brand" /><p className="text-xs text-content-muted">{Math.round(job.progress)}%</p></div>}
    {job.error && <p className="whitespace-pre-wrap break-words text-xs text-danger">{job.error}</p>}
    {job.result?.summary && <p className="whitespace-pre-wrap break-words text-sm text-content-secondary">{job.result.summary}</p>}
    {job.status === 'uncertain' && <div className="space-y-2 rounded-control bg-brand-soft p-3">
      <p className="text-xs leading-relaxed">服务商可能已收到任务。填写服务商任务编号后继续查询，可避免重复提交。</p>
      <label className="block space-y-1"><span className="text-xs">服务商任务编号</span><Input value={remoteId} onChange={event => setRemoteId(event.target.value)} disabled={pending} placeholder={job.remoteId || '在服务商任务记录中查找'} /></label>
      <Button size="sm" disabled={pending || (!remoteId.trim() && !job.remoteId)} onClick={() => onResume(remoteId.trim() || undefined)}>恢复任务查询</Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => setRetryConfirmation(true)}>重新提交任务</Button>
    </div>}
    {!!job.result?.files?.length && <CreativeProductionFiles files={job.result.files} />}
    {job.result?.data !== undefined && <CreativeToolboxCandidates data={job.result.data} tool={tool} disabled={!canApply || pending || !tool?.available || job.status !== 'completed'} onDownload={onStartCandidate} />}
    {job.result?.data !== undefined && <details className="rounded-control bg-elevated p-3"><summary className="cursor-pointer text-xs font-semibold">查看结果数据</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(job.result.data, null, 2)}</pre></details>}
    {job.status === 'completed' && usableFiles.length > 0 && <div className="space-y-3 border-t border-outline pt-3">
      <p className="text-xs font-semibold text-content-secondary">将产物用于当前项目</p>
      {usableFiles.length > 1 && <BaseSelect value={selectedFile?.url ?? ''} onChange={setFileUrl} options={usableFiles.map(file => ({ value: file.url, label: file.name }))} placeholder="选择产物" disabled={pending} />}
      {selectedFile?.kind === 'subtitle' ? <div className="space-y-2"><BaseSelect value={sourceId} onChange={setSourceId} options={(project.production?.sources ?? []).filter(source => source.kind === 'video' || source.kind === 'audio').map(source => ({ value: source.id, label: source.name }))} placeholder="选择字幕对应的原始素材" disabled={pending} /><Button size="sm" disabled={!canApply || pending || !sourceId} onClick={() => onApply({ fileUrl: selectedFile.url, sourceId })}>写入素材字幕</Button>{!project.production?.sources.some(source => source.kind !== 'image') && <p className="text-xs text-content-muted">请先在创作需求中上传字幕对应的视频或音频。</p>}</div>
        : selectedFile?.kind === 'model' ? <Button size="sm" disabled={!canApply || pending || notice?.fileUrl === selectedFile.url} onClick={() => onApply({ fileUrl: selectedFile.url })}>{notice?.fileUrl === selectedFile.url ? '已加入三维模型库' : '加入三维模型库'}</Button>
          : <><Input aria-label={`任务 ${job.id} 的素材名称`} value={sourceName} onChange={event => setSourceName(event.target.value)} disabled={pending} placeholder={`素材名称（默认：${selectedFile?.name ?? tool?.name ?? job.toolId}）`} />
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={!canApply || pending || sourceImported} onClick={() => onApply({ fileUrl: selectedFile?.url, sourceName: sourceName.trim() || undefined })}>{sourceImported ? '已加入项目素材库' : '加入项目素材库'}</Button>
        {project.shots.length > 0 && <><div className="min-w-[160px] flex-1"><BaseSelect value={shotId} onChange={setShotId} options={project.shots.map(shot => ({ value: shot.id, label: shot.title }))} placeholder="选择目标镜头" disabled={pending} /></div><Button size="sm" disabled={!canApply || pending || !shotId || appliedToShot} onClick={() => onApply({ fileUrl: selectedFile?.url, shotId })}>{appliedToShot ? '已应用到镜头' : '应用到镜头'}</Button></>}
      </div>
      {sourceImported && <p role="status" className="text-xs text-success">产物已加入项目素材库，可到创作需求中选择并编排。</p>}
      </>}
      {notice?.fileUrl === selectedFile?.url && <p role="status" className="text-xs text-success">{notice?.message}</p>}
    </div>}
    <div className="flex flex-wrap gap-2">
      {(activeStatus(job.status) || job.status === 'uncertain') && <Button size="sm" disabled={pending} onClick={onCancel}>停止任务</Button>}
      {(job.status === 'failed' || job.status === 'cancelled') && <><Button size="sm" disabled={pending} onClick={() => onResume()}>{job.remoteId ? '继续查询原任务' : '恢复处理'}</Button><Button size="sm" disabled={pending} onClick={() => setRetryConfirmation(true)}>重新提交任务</Button></>}
      {!activeStatus(job.status) && job.status !== 'uncertain' && <Button size="sm" variant="ghost" disabled={pending} onClick={onReuse}>复用参数</Button>}
    </div>
    <Modal open={retryConfirmation} onOpenChange={setRetryConfirmation} title="确认重新提交" footer={<><Button onClick={() => setRetryConfirmation(false)}>取消</Button><Button variant="primary" onClick={() => { setRetryConfirmation(false); onRetrySubmission() }}>确认重新提交</Button></>}>
      <p className="text-sm leading-relaxed">原请求可能已计费，再次提交可能重复计费。确认后将使用原来的参数再次提交任务。</p>
    </Modal>
  </article>
}

export function CreativeToolboxPanel({ project, disabled, canRun, onProjectUpdated, onBusyChange }: {
  project: CreativeProject; disabled: boolean; canRun: boolean
  onProjectUpdated: (project: CreativeProject) => void; onBusyChange: (busy: boolean) => void
}) {
  const client = useQueryClient()
  const catalog = useQuery(toolboxQueries.catalog())
  const jobs = useQuery(toolboxQueries.project(project.id))
  const configs = useQuery({ queryKey: qk.aiConfigs(), queryFn: ({ signal }) => aiConfigApi.list(undefined, signal) })
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [provider, setProvider] = useState('')
  const [availableOnly, setAvailableOnly] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [visibleCount, setVisibleCount] = useState(24)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState<string | null>(null)
  const [pendingJobId, setPendingJobId] = useState<number | null>(null)
  const [notices, setNotices] = useState<Record<number, { fileUrl?: string; message: string }>>({})
  const editorRef = useRef<HTMLDivElement>(null)
  useEffect(() => { editorRef.current?.scrollIntoView?.({ block: 'start' }) }, [selectedId])
  const tools = useMemo(() => catalog.data?.tools ?? [], [catalog.data?.tools])
  const selected = tools.find(tool => tool.id === selectedId)
  const draft = selected ? drafts[selected.id] ?? { args: toolboxDefaults(selected), configId: '' } : null
  const options = configs.data?.filter(config => config.isActive && config.serviceType === selected?.serviceType && (selected.provider === 'shared' || selected.provider === 'public' || config.provider === selected.provider)).sort((a, b) => b.priority - a.priority) ?? []
  const selectedConfig = draft?.configId ? options.find(config => String(config.id) === draft.configId) : options[0]
  const requiresConfig = !!selected?.serviceType && selected.provider !== 'public'
  const missingConfig = requiresConfig && !selectedConfig
  const matching = useMemo(() => tools.filter(tool => (!category || tool.category === category) && (!provider || tool.provider === provider) && (!availableOnly || tool.available) && `${tool.name} ${tool.id} ${tool.description} ${tool.provider}`.toLowerCase().includes(search.toLowerCase())), [tools, category, provider, availableOnly, search])
  const updateDraft = (tool: ToolboxDefinition, patch: Partial<Draft>) => setDrafts(previous => ({ ...previous, [tool.id]: { ...(previous[tool.id] ?? { args: toolboxDefaults(tool), configId: '' }), ...patch } }))
  const refresh = () => { void client.invalidateQueries({ queryKey: toolboxQueries.project(project.id).queryKey }) }
  const mutation = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onMutate: () => client.cancelQueries({ queryKey: toolboxQueries.project(project.id).queryKey }),
    onSuccess: async result => {
      await client.cancelQueries({ queryKey: toolboxQueries.project(project.id).queryKey })
      if (result && typeof result === 'object' && 'toolId' in result && 'status' in result && 'id' in result) {
        const job = result as ToolboxJob
        client.setQueryData<ToolboxJob[]>(toolboxQueries.project(project.id).queryKey, previous => [job, ...(previous ?? []).filter(item => item.id !== job.id)])
      }
      refresh()
    },
    onError: cause => setError(cause instanceof Error ? cause.message : String(cause)),
    onSettled: () => setPendingJobId(null),
  })
  const busy = mutation.isPending || uploading !== null
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false) }, [busy, onBusyChange])
  const submit = () => {
    if (!selected || !draft || !canRun || disabled || busy || missingConfig || !selected.available) return
    try {
      const args = toolboxArguments(selected, draft.args)
      setError(null)
      mutation.mutate(() => toolboxApi.start(project.id, project.revision, selected.id, args, selectedConfig?.id))
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const upload = async (tool: ToolboxDefinition, field: ToolboxInput, file: File) => {
    setUploading(field.key); setError(null)
    try {
      const previousUrls = isMediaCollection(field) ? mediaCollectionValue(drafts[tool.id]?.args[field.key] ?? toolboxDefaults(tool)[field.key]) : null
      const result = await toolboxApi.upload(project.id, file)
      setDrafts(previous => ({ ...previous, [tool.id]: { args: { ...toolboxDefaults(tool), ...previous[tool.id]?.args, [field.key]: previousUrls ? JSON.stringify([...new Set([...previousUrls, result.url])], null, 2) : result.url }, configId: previous[tool.id]?.configId ?? '' } }))
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setUploading(null) }
  }
  const actOnJob = (job: ToolboxJob, action: () => Promise<unknown>) => { setError(null); setPendingJobId(job.id); mutation.mutate(action) }
  return <div className="space-y-4">
    <CreativeSection title="制作工具箱" hint="按制作任务选择工具，调整输入后执行；任务记录与产物保存在当前项目。" action={<div className="flex flex-wrap items-center gap-3"><Button size="sm" variant="ghost" disabled={catalog.isFetching} onClick={() => void catalog.refetch()}>刷新工具</Button><Link to="/settings" className="inline-flex items-center gap-1 text-xs text-brand-content underline"><Settings2 size={13} aria-hidden />模型与服务配置</Link></div>}>
      <div className="flex flex-wrap gap-2 text-xs text-content-muted"><span>{tools.length} 项工具</span><span>·</span><span>{tools.filter(tool => tool.available).length} 项当前可用</span></div>
      {catalog.isError && <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-sm text-danger">{catalog.error.message}<Button size="sm" onClick={() => void catalog.refetch()}>重新读取工具</Button></div>}
      {configs.isError && <p role="alert" className="mt-3 text-xs text-danger">模型配置无法读取：{configs.error.message}<Button size="sm" onClick={() => void configs.refetch()}>重试配置</Button></p>}
      {catalog.isPending && <p role="status" className="mt-3 flex items-center gap-2 text-sm text-content-muted"><Loader2 size={15} className="animate-spin" aria-hidden />正在读取工具目录…</p>}
      <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_160px_160px]">
        <label className="relative"><span className="sr-only">搜索制作工具</span><Search size={15} className="absolute left-3 top-3 text-content-muted" aria-hidden /><Input value={search} onChange={event => { setSearch(event.target.value); setVisibleCount(24) }} placeholder="搜索功能、名称、服务商" className="pl-9" /></label>
        <BaseSelect value={category} onChange={value => { setCategory(value); setVisibleCount(24) }} options={[{ value: '', label: '全部分类' }, ...[...new Set(tools.map(tool => tool.category))].map(value => ({ value, label: categoryLabel(value) }))]} searchable={false} />
        <BaseSelect value={provider} onChange={value => { setProvider(value); setVisibleCount(24) }} options={[{ value: '', label: '全部服务商' }, ...[...new Set(tools.map(tool => tool.provider))].map(value => ({ value, label: value }))]} />
      </div>
      <label className="mt-3 flex items-center gap-2 text-xs text-content-secondary"><input type="checkbox" checked={availableOnly} onChange={event => { setAvailableOnly(event.target.checked); setVisibleCount(24) }} />只看当前可用工具</label>
      <div className="mt-4 grid max-h-[480px] gap-2 overflow-y-auto p-1 sm:grid-cols-2 xl:grid-cols-3">
        {matching.slice(0, visibleCount).map(tool => <button key={tool.id} type="button" aria-pressed={selectedId === tool.id} onClick={() => { setSelectedId(tool.id); setError(null) }} className={cn('min-w-0 space-y-2 rounded-control border p-3 text-left focus-visible:outline-none focus-visible:shadow-focus', selectedId === tool.id ? 'border-brand bg-brand-soft' : 'border-outline bg-transparent hover:bg-hover-overlay')}>
          <span className="flex items-start justify-between gap-2"><span className="break-words text-sm font-semibold">{tool.name}</span><Wrench size={14} className="mt-0.5 shrink-0 text-content-muted" aria-hidden /></span>
          <span className="block line-clamp-2 text-xs leading-relaxed text-content-muted">{tool.description}</span>
          <span className="flex flex-wrap gap-2 text-[10px] text-content-muted"><span>{categoryLabel(tool.category)}</span><span>{tool.provider}</span><span className={tool.available ? 'text-success' : 'text-content-subtle'}>{tool.available ? '可执行' : tool.implemented === false ? '尚未接入' : '需配置或依赖'}</span></span>
        </button>)}
      </div>
      {!catalog.isPending && !catalog.isError && !matching.length && <p className="mt-4 text-sm text-content-muted">没有符合条件的工具，请调整搜索或筛选条件。</p>}
      {matching.length > visibleCount && <Button className="mt-3" size="sm" onClick={() => setVisibleCount(value => value + 24)}>显示更多（还有 {matching.length - visibleCount} 项）</Button>}
    </CreativeSection>

    {selected && draft && <div ref={editorRef} className="scroll-mt-4"><CreativeSection title={selected.name} hint={selected.description}>
      <p className="mb-4 break-all text-xs text-content-subtle">{selected.id} · {selected.provider}</p>
      {!selected.available && <p role="status" className="mb-4 rounded-control bg-brand-soft p-3 text-sm text-brand-content">{selected.reason || '当前运行环境尚未满足此工具的执行条件。'} {selected.serviceType && <Link to="/settings" className="underline">前往配置模型与服务</Link>}</p>}
      {requiresConfig && <div className="mb-4 space-y-2"><p className="text-xs font-semibold text-content-secondary">调用配置</p><BaseSelect value={draft.configId} onChange={value => updateDraft(selected, { configId: value })} options={[{ value: '', label: selectedConfig ? `默认 · ${options[0]?.name} · ${options[0]?.models[0] ?? ''}` : '未找到已启用配置' }, ...options.map(config => ({ value: String(config.id), label: `${config.name} · ${config.models[0] ?? config.provider}` }))]} disabled={busy || disabled} />
        {missingConfig && <p role="status" className="text-xs text-brand-content">需要启用 {selected.provider === 'shared' ? '共用模型' : selected.provider} 的 {selected.serviceType} 配置。<Link to="/settings" className="ml-1 underline">前往设置</Link></p>}
      </div>}
      <div className="grid gap-4 lg:grid-cols-2">{selected.inputs.map(field => <Field key={field.key} field={field} value={draft.args[field.key]} project={project} outputs={jobs.data?.flatMap(job => job.result?.files ?? []) ?? []} disabled={busy || disabled} uploadPending={uploading === field.key} onChange={value => updateDraft(selected, { args: { ...draft.args, [field.key]: value } })} onUpload={file => void upload(selected, field, file)} />)}</div>
      {!canRun && <p role="status" className="mt-4 text-xs text-brand-content">请先保存项目修改，并等待当前编辑操作完成。</p>}
      <Button className="mt-4" variant="primary" disabled={disabled || busy || !canRun || !selected.available || missingConfig} loading={mutation.isPending && pendingJobId === null} onClick={submit}>执行工具</Button>
    </CreativeSection></div>}
    {error && <p role="alert" className="whitespace-pre-wrap break-words rounded-control bg-danger-soft p-3 text-sm text-danger">{error}</p>}
    <CreativeSection title="工具任务记录" hint="运行中的任务会自动更新；离开页面后仍可返回查看记录。">
      {jobs.isPending && <p role="status" className="text-sm text-content-muted">正在读取任务…</p>}
      {jobs.isError && <div role="alert" className="text-sm text-danger">{jobs.error.message}<Button size="sm" onClick={() => void jobs.refetch()}>重新读取记录</Button></div>}
      {!jobs.isPending && !jobs.isError && !jobs.data?.length && <p className="text-sm text-content-muted">还没有工具任务。选择上方工具开始制作。</p>}
      <div className="space-y-3">{jobs.data?.map(job => <JobCard key={job.id} job={job} tool={tools.find(tool => tool.id === job.toolId)} project={project} canApply={canRun && !disabled} pending={mutation.isPending} notice={notices[job.id]} onResume={remoteId => actOnJob(job, () => toolboxApi.resume(project.id, job.id, remoteId))} onRetrySubmission={() => actOnJob(job, () => toolboxApi.resume(project.id, job.id, undefined, true))} onCancel={() => actOnJob(job, () => toolboxApi.cancel(project.id, job.id))} onApply={value => actOnJob(job, async () => { const updated = await toolboxApi.apply(project.id, job.id, project.revision, value); onProjectUpdated(updated); void client.invalidateQueries({ queryKey: toolQueries.project(project.id).queryKey }); const file = job.result?.files?.find(item => item.url === value.fileUrl); setNotices(previous => ({ ...previous, [job.id]: { fileUrl: value.fileUrl, message: value.sourceId ? '字幕已写入素材，可在创作需求中检查并编排。' : file?.kind === 'model' ? '模型已加入三维模型库，可在制作工具中进行骨骼绑定。' : value.shotId ? '产物已应用到所选镜头。' : '产物已加入项目素材库。' } })) })} onStartCandidate={(index, id) => actOnJob(job, () => toolboxApi.start(project.id, project.revision, job.toolId, { ...job.input.args, download: true, index, selected_id: id || undefined }, job.input.configId))} onReuse={() => { const tool = tools.find(item => item.id === job.toolId); if (!tool) return; const args = Object.fromEntries(tool.inputs.map(field => [field.key, field.type === 'json' && job.input.args[field.key] !== undefined ? JSON.stringify(job.input.args[field.key], null, 2) : job.input.args[field.key] ?? toolboxDefaults(tool)[field.key]])); setDrafts(previous => ({ ...previous, [tool.id]: { args, configId: job.input.configId ? String(job.input.configId) : '' } })); setSelectedId(tool.id); setError(null) }} />)}</div>
    </CreativeSection>
  </div>
}
