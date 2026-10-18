import { useState } from 'react'
import { useProductionText } from '@/entities/creative/catalog'
import { CheckCircle2, Download, Film, Loader2, Play, Subtitles } from 'lucide-react'
import { creativeMediaUrl, taskIsActive, type CreativeDraft, type CreativeProject } from '@/entities/creative/model'
import { Button, buttonVariants } from '@/shared/ui/button'
import { cn } from '@/shared/lib/cn'
import { CreativeSection, hintClass } from './CreativeFields'
import { shotHasMedia } from './creative-draft'
import type { CreativeCopy } from './creative-locales'

export function CreativeExportPanel({ project, draft, copy, canRender, rendering, onRender, onPreview }: {
  project: CreativeProject
  draft: CreativeDraft
  copy: CreativeCopy
  canRender: boolean
  rendering: boolean
  onRender: (individual?: boolean) => void
  onPreview: (url: string, title: string) => void
}) {
  const text = useProductionText()
  const [individual, setIndividual] = useState(project.category === 'clip_factory')
  const ready = draft.shots.filter(shotHasMedia).length
  const duration = draft.shots.reduce((sum, shot) => sum + (Number.isFinite(shot.duration) ? shot.duration : 0), 0)
  const readyForExport = draft.shots.length > 0 && ready === draft.shots.length
  return <div className="flex flex-col gap-4">
    <CreativeSection title={copy.exportTitle} hint={copy.exportHint}>
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-control bg-elevated p-4"><p className={hintClass}>{copy.readyMedia}</p><p className="mt-1 text-xl font-bold">{ready}<span className="text-sm font-normal text-content-muted"> / {draft.shots.length}</span></p></div>
        <div className="rounded-control bg-elevated p-4"><p className={hintClass}>{copy.totalDuration}</p><p className="mt-1 text-xl font-bold">{duration.toFixed(1).replace(/\.0$/, '')}<span className="ml-1 text-sm font-normal text-content-muted">{copy.seconds}</span></p></div>
        <div className="rounded-control bg-elevated p-4"><p className={hintClass}>{copy.revision}</p><p className="mt-1 text-xl font-bold">{project.revision}<span className="ml-2 text-sm font-normal text-content-muted">{project.aspectRatio}</span></p></div>
      </div>
      {!readyForExport && <p className="mb-4 text-xs text-content-muted">{copy.missingMedia}</p>}
      <label className="mb-4 flex items-center gap-2 text-sm"><input type="checkbox" disabled={rendering} checked={individual} onChange={event=>setIndividual(event.target.checked)} className="size-4 accent-brand" />{text('每个画面分别导出为独立视频','Export each shot as a separate video')}</label>
      {individual && <p className="mb-3 text-xs text-content-muted">{text('适用于长视频切片和播客选段；配乐会加入每条视频。请使用片段原声，整片配音不适用于逐条导出。','For source clips and podcast excerpts. Music is mixed into each clip. Use clip audio; a full-length voiceover cannot be used for separate exports.')}</p>}
      <Button variant="primary" disabled={!canRender || !readyForExport || (individual && !!draft.audio.narrationUrl)} loading={rendering} onClick={()=>onRender(individual)}><Film size={15} aria-hidden />{copy.render}</Button>
    </CreativeSection>
    <CreativeSection title={copy.renderHistory}>
      {project.renders.length === 0 ? <div className="flex min-h-32 items-center justify-center rounded-control border border-dashed border-outline-strong p-6 text-center"><p className={hintClass}>{copy.noRenders}</p></div>
        : <div className="flex flex-col gap-3">{project.renders.map((render) => {
          const pending = taskIsActive(render.status)
          const success = render.status === 'completed' && (!!render.videoUrl || !!render.outputs?.length)
          const video = creativeMediaUrl(render.videoUrl)
          const subtitle = creativeMediaUrl(render.subtitleUrl)
          const statusLabel = pending ? copy.rendering : success ? copy.completed : copy.failed
          return <article key={render.id} className="rounded-control border border-outline bg-elevated p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className={cn('flex items-center gap-2 text-sm font-semibold', success ? 'text-success' : pending ? 'text-brand-content' : 'text-danger')}>
                  {pending ? <Loader2 size={15} className="animate-spin" aria-hidden /> : success ? <CheckCircle2 size={15} aria-hidden /> : <Film size={15} aria-hidden />}{statusLabel}
                  <span className="text-xs font-normal text-content-muted">#{render.id} · {copy.revision} {render.revision}</span>
                </p>
                <p className="mt-1 text-[11px] text-content-subtle">{new Date(render.createdAt).toLocaleString()}{render.duration != null ? ` · ${render.duration.toFixed(1)} ${copy.seconds}` : ''}</p>
              </div>
              {success && !!render.videoUrl && <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => onPreview(video, `${project.title} · ${copy.revision} ${render.revision}`)}><Play size={13} aria-hidden />{copy.preview}</Button>
                <a className={buttonVariants({ size: 'sm' })} href={video} download><Download size={13} aria-hidden />{copy.downloadVideo}</a>
                {subtitle && <a className={buttonVariants({ size: 'sm', variant: 'ghost' })} href={subtitle} download><Subtitles size={13} aria-hidden />{copy.downloadSubtitles}</a>}
              </div>}
            </div>
            {!!render.outputs?.length && <ul className="mt-3 space-y-2">{render.outputs.map(output=><li key={output.shotId} className="flex flex-wrap items-center gap-2 rounded-control border border-outline p-2 text-xs"><span className="min-w-0 flex-1 truncate">{output.title} · {output.duration.toFixed(1)}s</span><Button size="sm" onClick={()=>onPreview(creativeMediaUrl(output.videoUrl),output.title)}>{copy.preview}</Button><a className={buttonVariants({size:'sm'})} href={creativeMediaUrl(output.videoUrl)} download>{copy.downloadVideo}</a>{output.subtitleUrl && <a className={buttonVariants({size:'sm',variant:'ghost'})} href={creativeMediaUrl(output.subtitleUrl)} download>{copy.downloadSubtitles}</a>}</li>)}</ul>}
            {pending && <div className="mt-4 flex items-center gap-3" role="status"><progress aria-label={copy.rendering} max={100} value={render.progress} className="h-1.5 flex-1 accent-brand" /><span className="text-xs text-content-muted">{Math.round(render.progress)}%</span></div>}
            {render.errorMsg && <p role="alert" className="mt-3 break-words text-xs leading-relaxed text-danger">{render.errorMsg}</p>}
            {render.warnings.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-4 text-xs leading-relaxed text-content-muted">{render.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
          </article>
        })}</div>}
    </CreativeSection>
  </div>
}
