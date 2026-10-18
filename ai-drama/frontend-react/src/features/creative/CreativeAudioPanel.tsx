import { useProductionText } from '@/entities/creative/catalog'
import { BaseSelect } from '@/shared/ui/BaseSelect'
import { ArrowRight, Music2, Mic2 } from 'lucide-react'
import { creativeMediaUrl, type CreativeDraft } from '@/entities/creative/model'
import { Button } from '@/shared/ui/button'
import { CreativeField, CreativeSection, MediaUpload, hintClass } from './CreativeFields'
import type { CreativeCopy } from './creative-locales'

export function CreativeAudioPanel({ draft, copy, disabled, uploading, onChange, onUpload, onNext, canTranslate, translating, onTranslate, onTargetLanguage, onMuteSource }: {
  draft: CreativeDraft
  copy: CreativeCopy
  disabled: boolean
  uploading: string | null
  onChange: (patch: Partial<CreativeDraft['audio']>) => void
  onUpload: (kind: 'narration' | 'music', file: File) => void
  onNext: () => void
  canTranslate: boolean
  translating: boolean
  onTranslate: () => void
  onTargetLanguage: (value: string) => void
  onMuteSource: () => void
}) {
  const text = useProductionText()
  return <div className="flex flex-col gap-4">
    {(['narration', 'music'] as const).map((kind) => {
      const key = kind === 'narration' ? 'narrationUrl' : 'musicUrl'
      const url = creativeMediaUrl(draft.audio[key])
      const Icon = kind === 'narration' ? Mic2 : Music2
      return <CreativeSection key={kind} title={kind === 'narration' ? copy.voiceover : copy.music} hint={kind === 'narration' ? copy.voiceoverHint : draft.plan.musicDirection || undefined}>
        <div className="flex flex-col gap-4">
          {url ? <audio controls src={url} preload="metadata" className="w-full" aria-label={kind === 'narration' ? copy.voiceover : copy.music} />
            : <div className="flex items-center gap-3 rounded-control bg-elevated p-4 text-content-muted"><Icon size={22} aria-hidden /><span className="text-xs">{copy.noAudio}</span></div>}
          <div className="flex flex-wrap gap-2">
            <MediaUpload label={copy.uploadAudio} accept="audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/aac,audio/flac" disabled={disabled} loading={uploading === kind} onFile={(file) => onUpload(kind, file)} />
            {url && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange({ [key]: null })}>{copy.removeAudio}</Button>}
          </div>
          {kind === 'music' && <CreativeField label={`${copy.musicVolume} ${Math.round(draft.audio.musicVolume * 100)}%`}><input disabled={disabled} type="range" min={0} max={1} step={0.05} value={draft.audio.musicVolume} className="w-full accent-brand" onChange={(event) => onChange({ musicVolume: event.target.valueAsNumber })} /></CreativeField>}
        </div>
      </CreativeSection>
    })}
    <CreativeSection title={text('配音替换与字幕翻译','Dubbing and caption translation')} hint={text('翻译使用当前文本模型，保留每段时码。配音可上传，或在创作需求中启用流程自动配音。','Translation preserves timing. Upload dubbing or enable automatic speech in the creative brief.')}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-40"><CreativeField label={text('翻译目标语言','Translation language')}><BaseSelect value={draft.brief.language} disabled={disabled} options={[{value:'zh-CN',label:'中文'},{value:'en',label:'English'},{value:'ja',label:'日本語'},{value:'ko',label:'한국어'},{value:'es',label:'Español'},{value:'fr',label:'Français'},{value:'de',label:'Deutsch'}]} onChange={onTargetLanguage}/></CreativeField></div>
        <Button disabled={!canTranslate} loading={translating} onClick={onTranslate}>{text('翻译字幕与旁白','Translate captions and narration')}</Button>
        <Button disabled={disabled} onClick={onMuteSource}>{text('关闭所有片段原声','Mute all clip audio')}</Button>
      </div>
    </CreativeSection>
    <CreativeSection title={copy.subtitles} hint={copy.subtitlesHint}>
      <label className="flex cursor-pointer items-center gap-3 text-sm"><input type="checkbox" checked={draft.audio.burnSubtitles} disabled={disabled} onChange={(event) => onChange({ burnSubtitles: event.target.checked })} className="size-4 accent-brand" /><span>{copy.burnSubtitles}</span></label>
      <p className={`${hintClass} mt-3`}>{copy.captionCount}: {draft.shots.filter((shot) => shot.caption.trim()).length} / {draft.shots.length}</p>
    </CreativeSection>
    <div className="flex justify-end"><Button onClick={onNext}>{copy.nextExport}<ArrowRight size={14} aria-hidden /></Button></div>
  </div>
}
