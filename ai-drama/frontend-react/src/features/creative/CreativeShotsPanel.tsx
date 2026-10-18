import { useProductionText } from '@/entities/creative/catalog'
import { ArrowDown, ArrowUp, Image, ImagePlus, Plus, Sparkles, Trash2, Video } from 'lucide-react'
import { creativeMediaUrl, taskIsActive, type CreativeDraft, type CreativeProject, type CreativeShot } from '@/entities/creative/model'
import { Button, IconButton } from '@/shared/ui/button'
import { Input, Textarea } from '@/shared/ui/input'
import { cn } from '@/shared/lib/cn'
import { CreativeField, CreativeSection, MediaUpload, hintClass } from './CreativeFields'
import { shotHasMedia } from './creative-draft'
import type { CreativeCopy } from './creative-locales'

export function CreativeShotsPanel({ project, draft, copy, selectedId, disabled, canGenerate, uploading, generating, onSelect, onAdd, onUpdate, onMove, onDelete, onUpload, onGenerate, onPreview }: {
  project: CreativeProject
  draft: CreativeDraft
  copy: CreativeCopy
  selectedId: string | null
  disabled: boolean
  canGenerate: boolean
  uploading: string | null
  generating: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  onUpdate: (id: string, patch: Partial<CreativeShot>) => void
  onMove: (id: string, delta: -1 | 1) => void
  onDelete: (id: string) => void
  onUpload: (id: string, kind: 'image' | 'video' | 'audio', file: File) => void
  onGenerate: (id: string, kind: 'image' | 'video') => void
  onPreview: (src: string, title: string) => void
}) {
  const text = useProductionText()
  const shot = draft.shots.find((item) => item.id === selectedId) ?? draft.shots[0]
  const selectedIndex = draft.shots.findIndex((item) => item.id === shot?.id)
  const liveShot = project.shots.find((item) => item.id === shot?.id)
  const task = shot?.mediaType === 'video' ? liveShot?.videoTask : liveShot?.imageTask
  const totalDuration = draft.shots.reduce((sum, item) => sum + (Number.isFinite(item.duration) ? item.duration : 0), 0)
  const mediaSrc = creativeMediaUrl(shot?.mediaType === 'video' ? shot.videoUrl : shot?.imageUrl)

  return <CreativeSection title={copy.shots} hint={`${draft.shots.length} ${copy.shot} · ${copy.totalDuration} ${totalDuration.toFixed(1).replace(/\.0$/, '')} ${copy.seconds}`} action={<Button size="sm" disabled={disabled || draft.shots.length >= 200} onClick={onAdd}><Plus size={14} aria-hidden />{copy.addShot}</Button>}>
    {!shot ? <div className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-control border border-dashed border-outline-strong p-6 text-center">
      <ImagePlus size={32} className="text-content-subtle" aria-hidden />
      <h3 className="text-sm font-semibold">{copy.emptyShots}</h3><p className={hintClass}>{copy.emptyShotsHint}</p>
      <Button disabled={disabled} onClick={onAdd}><Plus size={14} aria-hidden />{copy.addShot}</Button>
    </div> : <div className="flex min-w-0 flex-col gap-4">
      <div role="group" aria-label={copy.shots} className="flex gap-2 overflow-x-auto pb-2">
        {draft.shots.map((item, index) => {
          const live = project.shots.find((candidate) => candidate.id === item.id)
          const currentTask = item.mediaType === 'video' ? live?.videoTask : live?.imageTask
          return <button type="button" key={item.id} onClick={() => onSelect(item.id)} aria-pressed={item.id === shot.id} className={cn('flex min-w-32 max-w-48 shrink-0 flex-col gap-2 rounded-control border border-solid p-3 text-left transition-colors focus-visible:outline-none focus-visible:shadow-focus', item.id === shot.id ? 'border-brand bg-brand-soft text-content' : 'border-outline bg-elevated text-content-muted hover:border-outline-hover')}>
            <span className="flex items-center gap-2 text-[11px]"><span className="font-code text-brand">{String(index + 1).padStart(2, '0')}</span><span>{item.duration || 0} {copy.seconds}</span><span className={cn('ml-auto size-1.5 rounded-full', taskIsActive(currentTask?.status) ? 'animate-pulse bg-brand' : currentTask?.status === 'failed' ? 'bg-danger' : shotHasMedia(item) ? 'bg-success' : 'bg-content-subtle')} /></span>
            <span className="w-full truncate text-xs font-semibold">{item.title || `${copy.shot} ${index + 1}`}</span>
          </button>
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-outline pt-3">
        <h3 className="text-sm font-bold">{copy.shot} {String(selectedIndex + 1).padStart(2, '0')}</h3>
        <div className="flex items-center gap-1">
          <IconButton aria-label={copy.moveUp} title={copy.moveUp} disabled={disabled || selectedIndex === 0} onClick={() => onMove(shot.id, -1)}><ArrowUp size={15} aria-hidden /></IconButton>
          <IconButton aria-label={copy.moveDown} title={copy.moveDown} disabled={disabled || selectedIndex === draft.shots.length - 1} onClick={() => onMove(shot.id, 1)}><ArrowDown size={15} aria-hidden /></IconButton>
          <IconButton variant="danger" aria-label={copy.remove} title={copy.remove} disabled={disabled} onClick={() => onDelete(shot.id)}><Trash2 size={15} aria-hidden /></IconButton>
        </div>
      </div>
      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-4 border-0 p-0">
          <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-3">
            <CreativeField label={copy.shotTitle}><Input value={shot.title} maxLength={200} onChange={(event) => onUpdate(shot.id, { title: event.target.value })} /></CreativeField>
            <CreativeField label={copy.duration}><Input type="number" min={0.04} max={600} step={0.01} value={Number.isFinite(shot.duration) ? shot.duration : ''} onChange={(event) => onUpdate(shot.id, { duration: event.target.valueAsNumber })} /></CreativeField>
          </div>
          <CreativeField label={copy.visualPrompt}><Textarea rows={4} value={shot.visualPrompt} onChange={(event) => onUpdate(shot.id, { visualPrompt: event.target.value })} /></CreativeField>
          <CreativeField label={copy.narration}><Textarea rows={3} value={shot.narration} onChange={(event) => onUpdate(shot.id, { narration: event.target.value })} /></CreativeField>
          <CreativeField label={copy.caption} hint={copy.captionHint}><Textarea rows={2} value={shot.caption} onChange={(event) => onUpdate(shot.id, { caption: event.target.value })} /></CreativeField>
        </fieldset>
        <div className="flex min-w-0 flex-col gap-3">
          <fieldset disabled={disabled} className="min-w-0 border-0 p-0">
            <legend className="mb-2 text-xs font-semibold text-content-secondary">{copy.mediaType}</legend>
            <div className="grid grid-cols-2 gap-2">
              {(['image', 'video'] as const).map((type) => <label key={type} className="relative cursor-pointer">
                <input className="peer sr-only" type="radio" name={`creative-media-${shot.id}`} value={type} checked={shot.mediaType === type} onChange={() => onUpdate(shot.id, { mediaType: type })} />
                <span className={cn('flex items-center justify-center gap-2 rounded-control border border-solid p-2.5 text-xs font-semibold peer-focus-visible:shadow-focus peer-disabled:cursor-not-allowed peer-disabled:opacity-45', shot.mediaType === type ? 'border-brand bg-brand-soft text-brand-content' : 'border-outline bg-elevated text-content-muted')}>
                  {type === 'image' ? <Image size={15} aria-hidden /> : <Video size={15} aria-hidden />}{copy[type]}
                </span>
              </label>)}
            </div>
          </fieldset>
          <div className="flex min-h-44 items-center justify-center overflow-hidden rounded-control border border-outline bg-black/40" style={{ aspectRatio: project.aspectRatio.replace(':', '/'), maxHeight: 330 }}>
            {mediaSrc ? shot.mediaType === 'video'
              ? <video key={mediaSrc} src={mediaSrc} controls playsInline preload="metadata" className="h-full max-h-[330px] w-full object-contain" aria-label={`${copy.preview} ${shot.title}`} />
              : <button type="button" aria-label={`${copy.previewImage} ${shot.title}`} className="h-full w-full cursor-zoom-in border-0 bg-transparent p-0 focus-visible:shadow-focus" onClick={() => onPreview(mediaSrc, shot.title)}><img src={mediaSrc} alt={shot.title} className="h-full max-h-[330px] w-full object-contain" /></button>
              : <div className="flex flex-col items-center gap-3 p-5 text-content-subtle"><ImagePlus size={30} aria-hidden /><span className="text-xs">{copy.noMedia}</span></div>}
          </div>
          <p className={hintClass}>{shot.mediaType === 'image' ? copy.imageHint : copy.videoHint}</p>
          {taskIsActive(task?.status) && <p role="status" className="rounded-control bg-brand-soft px-3 py-2 text-xs text-brand-content">{task?.status === 'pending' || task?.status === 'queued' ? copy.pending : copy.processing}…</p>}
          {task?.status === 'failed' && <p role="alert" className="break-words rounded-control bg-danger-soft px-3 py-2 text-xs leading-relaxed text-danger">{copy.failed}: {task.errorMsg || copy.retry}</p>}
          <div className="flex flex-wrap gap-2">
            <MediaUpload accept={shot.mediaType === 'image' ? 'image/png,image/jpeg,image/webp' : 'video/mp4,video/webm,video/quicktime'} label={shot.mediaType === 'image' ? copy.uploadImage : copy.uploadVideo} disabled={disabled} loading={uploading === shot.id} onFile={(file) => onUpload(shot.id, shot.mediaType, file)} />
            <Button size="sm" variant="primary" disabled={!canGenerate || !shot.visualPrompt.trim() || taskIsActive(task?.status) || (shot.mediaType === 'video' && shot.duration > 15)} loading={generating === shot.id} onClick={() => onGenerate(shot.id, shot.mediaType)}><Sparkles size={13} aria-hidden />{mediaSrc ? copy.regenerate : shot.mediaType === 'image' ? copy.generateImage : copy.generateVideo}</Button>
          </div>
          {shot.mediaType === 'video' && shot.duration > 15 && <p className={hintClass}>{text('视频模型单次生成最多 15 秒，请拆分镜头；已有原片可以正常剪辑和导出。','Video generation supports up to 15 seconds per shot. Split it to generate; source clips can still be edited and exported.')}</p>}
          <div className="flex flex-wrap items-center gap-2 border-t border-outline pt-3">
            <MediaUpload accept="audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/flac" label={text('上传镜头配音','Upload shot voice')} disabled={disabled} loading={uploading === shot.id} onFile={file => onUpload(shot.id,'audio',file)}/>
            {shot.audioUrl && <Button size="sm" disabled={disabled} onClick={()=>onUpdate(shot.id,{audioUrl:null,audioTrimStart:0})}>{text('移除镜头配音','Remove shot voice')}</Button>}
          </div>
          {shot.audioUrl && <audio key={shot.audioUrl} src={creativeMediaUrl(shot.audioUrl)} controls preload="metadata" className="w-full" aria-label={text('片段音频','Clip audio')} />}
          {(shot.mediaType === 'video' || shot.audioUrl) && <fieldset disabled={disabled} className="grid min-w-0 gap-4 border-0 pt-2 sm:grid-cols-2">
            {shot.mediaType === 'video' && <CreativeField label={copy.trimStart}><Input type="number" min={0} step={0.1} value={Number.isFinite(shot.trimStart) ? shot.trimStart : ''} onChange={(event) => onUpdate(shot.id, { trimStart: event.target.valueAsNumber })} /></CreativeField>}
            {shot.audioUrl && <CreativeField label={text('音频起点（秒）','Audio start (s)')}><Input type="number" min={0} max={86400} step={0.1} value={Number.isFinite(shot.audioTrimStart ?? 0) ? (shot.audioTrimStart ?? 0) : ''} onChange={event => onUpdate(shot.id, {audioTrimStart: event.target.valueAsNumber})}/></CreativeField>}
            <CreativeField label={`${copy.originalVolume} ${Math.round(shot.originalVolume * 100)}%`}><input type="range" className="my-2 w-full accent-brand" min={0} max={1} step={0.05} value={shot.originalVolume} onChange={(event) => onUpdate(shot.id, { originalVolume: event.target.valueAsNumber })} /></CreativeField>
          </fieldset>}
        </div>
      </div>
    </div>}
  </CreativeSection>
}
