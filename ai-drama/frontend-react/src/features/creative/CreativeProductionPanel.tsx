import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { creativeApi } from '@/entities/creative/api'
import { creativeMediaUrl, newCreativeShot, type CreativeDraft, type CreativeProject } from '@/entities/creative/model'
import { useCatalogText, useProductionText, type CreativeRecipe } from '@/entities/creative/catalog'
import { Input, Textarea } from '@/shared/ui/input'
import { Button } from '@/shared/ui/button'
import { BaseSelect } from '@/shared/ui/BaseSelect'
import { CreativePipelineAutomation } from './CreativePipelineAutomation'
import { CreativeField, CreativeSection, MediaUpload, hintClass } from './CreativeFields'

export function CreativeProductionPanel({project, draft, recipe, disabled, canRun, onChange, onProjectUpdated, onBusyChange}: {
  project: CreativeProject; draft: CreativeDraft; recipe?: CreativeRecipe; disabled: boolean; canRun: boolean
  onChange: (update: (draft: CreativeDraft) => CreativeDraft) => void
  onProjectUpdated: (project: CreativeProject) => void; onBusyChange: (busy: boolean) => void
}) {
  const text = useProductionText(), localize = useCatalogText()
  const production = draft.production ?? { fields: {}, sources: [] }
  const [selected, setSelected] = useState('')
  const source = production.sources.find(item => item.id === selected) ?? production.sources[0]
  const [start, setStart] = useState(0), [end, setEnd] = useState(5)
  const [title, setTitle] = useState('')
  const [ranges, setRanges] = useState<{start:number;end:number;title:string;caption:string}[]>([])
  const [localError, setLocalError] = useState('')
  type Operation = {file:File} | {sourceId:string;selections?:typeof ranges;srt?:string;transcribe?:boolean}
  const operation = useMutation({ mutationFn: async (action: Operation) => {
    if ('file' in action) return creativeApi.sourceUpload(project.id, project.revision, action.file)
    if(action.transcribe)return creativeApi.sourceTranscribe(project.id,project.revision,action.sourceId)
    return creativeApi.sourceArrange(project.id, {revision: project.revision, ...action})
  }, onSuccess: (result, action) => {
    onProjectUpdated(result); setRanges([])
    if ('file' in action) {
      const added = result.production?.sources.at(-1)
      if (added) { setSelected(added.id); setStart(0); setEnd(Math.min(30, added.duration ?? 5)); setTitle('') }
    }
  }, onSettled: () => onBusyChange(false) })
  const run = (action: Operation) => { if (!canRun || operation.isPending) return; setLocalError(''); onBusyChange(true); operation.mutate(action) }
  const updateSource = (patch: Partial<{transcript:string;attribution:string}>) => onChange(value => ({...value,production:{...production,sources:production.sources.map(item => item.id === source?.id ? {...item,...patch} : item)}}))
  const currentRange = {start,end,title:title.trim() || source?.name || text('片段','Clip'),caption:''}
  const validRange = !!source?.duration && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end - start >= 1 / 30 && end <= source.duration && end - start <= 600
  return <>
    {recipe && <CreativeSection title={`${localize(recipe.title)} · ${text('制作要求','Production brief')}`} hint={localize(recipe.description)}>
      <ol className="mb-4 flex flex-wrap gap-2 text-xs text-brand-content">{recipe.steps.map((step,i) => <li className="rounded-control bg-brand-soft px-3 py-2" key={i}>{i+1}. {localize(step)}</li>)}</ol>
      <fieldset disabled={disabled} className="grid min-w-0 gap-4 border-0 p-0 sm:grid-cols-2">{recipe.fields.map(field => <CreativeField key={field.key} label={localize(field.label)}><Textarea rows={3} value={production.fields[field.key] ?? ''} maxLength={20000} placeholder={localize(field.placeholder)} onChange={event => onChange(value => ({...value,production:{...production,fields:{...production.fields,[field.key]:event.target.value}}}))} /></CreativeField>)}</fieldset>
      <p className={`${hintClass} mt-4`}>{localize(recipe.note)}</p>
    </CreativeSection>}
    <CreativePipelineAutomation project={project} draft={draft} disabled={disabled} onChange={onChange}/>
    <CreativeSection title={text('语音制作','Speech production')} hint={text('可选功能：使用「模型与服务」中对应的语音合成或语音识别配置。识别会发送原片音频，配音会发送旁白文字到该服务，按服务计费。合成语音请在成片说明中标明。','Optional: uses the speech or transcription configuration in Models & Services. Transcription sends source audio and speech synthesis sends narration to that provider, which may charge fees. Disclose AI-generated voices in your video.')}>
      <fieldset disabled={disabled} className="grid gap-3 border-0 p-0 sm:grid-cols-2">
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5 accent-brand" checked={production.fields.transcriptionMode==='openai'} onChange={e=>onChange(value=>({...value,production:{...production,fields:{...production.fields,transcriptionMode:e.target.checked?'openai':'manual'}}}))}/>{text('流程开始时自动识别缺少原稿的音视频','Transcribe sources missing a transcript when the workflow starts')}</label>
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5 accent-brand" checked={production.fields.speechMode==='openai'} onChange={e=>onChange(value=>({...value,production:{...production,fields:{...production.fields,speechMode:e.target.checked?'openai':'manual'}}}))}/>{text('素材阶段自动为缺少配音的镜头合成旁白','Generate missing shot narration during the assets stage')}</label>
        <CreativeField label={text('合成音色','Synthetic voice')}><BaseSelect disabled={disabled} value={production.fields.speechVoice||'coral'} options={['alloy','ash','coral','echo','fable','nova','onyx','sage','shimmer'].map(value=>({value,label:value}))} onChange={speechVoice=>onChange(value=>({...value,production:{...production,fields:{...production.fields,speechVoice}}}))}/></CreativeField>
      </fieldset>
    </CreativeSection>
    <CreativeSection title={text('原始素材与原稿','Source media and transcripts')} hint={text('上传图片、视频或音频，在项目中重复取段。单文件最大 512MB；字幕支持 SRT。','Upload images, video or audio and reuse ranges. Up to 512MB per file; SRT captions supported.')} action={<MediaUpload accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,audio/mp4,.m4v,.m4a,.aac" label={text('添加原始素材','Add source media')} disabled={!canRun} loading={operation.isPending} onFile={file => run({file})} />}>
      {!canRun && <p className="mb-3 text-xs text-brand-content">{text('请先保存修改或等待当前操作完成，再导入和编排素材。','Save your edits or wait for the current operation before importing or arranging sources.')}</p>}
      {(operation.isError || localError) && <p role="alert" className="mb-3 text-sm text-danger">{localError || operation.error?.message}</p>}
      {!source ? <p className={hintClass}>{recipe?.source === 'optional' ? text('可选：上传参考图片、已有片段或资料。','Optional: add references, footage or source material.') : text('此类型需要原始素材。先上传，再选择片段或导入字幕。','This type requires source media. Upload it before selecting ranges or importing captions.')}</p> : <div className="space-y-4">
        <BaseSelect aria-label={text('选择原始素材','Select source media')} value={source.id} disabled={disabled} options={production.sources.map(item => ({value:item.id,label:`${item.name}${item.duration ? ` · ${item.duration.toFixed(1)}s` : ''}`}))} onChange={id => {setSelected(id); setRanges([]); setStart(0); setEnd(Math.min(30,production.sources.find(item => item.id === id)?.duration || 5));setTitle('')}} />
        <div className="grid gap-4 md:grid-cols-2">
          <div className="min-w-0 space-y-2">
            {source.kind === 'video' ? <video key={source.url} src={creativeMediaUrl(source.url)} controls preload="metadata" className="max-h-56 w-full rounded-control bg-black" /> : source.kind === 'audio' ? <><img src={creativeMediaUrl(source.coverUrl)} alt={text('音频波形','Audio waveform')} className="max-h-40 w-full rounded-control bg-elevated object-contain" /><audio key={source.url} src={creativeMediaUrl(source.url)} controls preload="metadata" className="w-full" /></> : <img src={creativeMediaUrl(source.url)} alt={source.name} className="max-h-56 w-full rounded-control object-contain" />}
            <CreativeField label={text('素材说明 / 逐字稿','Description / transcript')} hint={text('可粘贴带时码的原稿，供 AI 策划和选段参考；不会凭空转录。','Paste a timestamped transcript for planning; missing speech is not invented.')}><Textarea rows={4} maxLength={60000} disabled={disabled} value={source.transcript} onChange={event => updateSource({transcript:event.target.value})} /></CreativeField>
            {source.kind!=='image'&&<div className="flex flex-wrap gap-2"><Button size="sm" disabled={!canRun||!!source.transcript.trim()} loading={operation.isPending} onClick={()=>run({sourceId:source.id,transcribe:true})}>{text('识别原声与时码','Transcribe source audio')}</Button>{source.transcript.includes('-->')&&<Button size="sm" disabled={!canRun} onClick={()=>run({sourceId:source.id,srt:source.transcript})}>{text('按原稿时码添加画面','Add shots from transcript timing')}</Button>}</div>}
            <CreativeField label={text('来源与使用说明','Attribution and usage notes')}><Input disabled={disabled} value={source.attribution} maxLength={2000} onChange={event => updateSource({attribution:event.target.value})} /></CreativeField>
          </div>
          <div className="min-w-0 space-y-3">
            {source.kind === 'image' ? <Button disabled={disabled} onClick={() => onChange(value => ({...value,shots:[...value.shots,{...newCreativeShot(source.name),imageUrl:source.url}]}))}><Plus size={14}/>{text('加入画面编排','Add to shots')}</Button> : <>
              <div className="grid grid-cols-2 gap-3"><CreativeField label={text('原片起点（秒）','Source start (s)')}><Input disabled={disabled} type="number" min={0} step={0.1} max={source.duration ?? undefined} value={Number.isFinite(start)?start:''} onChange={e=>setStart(e.target.valueAsNumber)}/></CreativeField><CreativeField label={text('原片终点（秒）','Source end (s)')}><Input disabled={disabled} type="number" min={0} step={0.1} max={source.duration ?? undefined} value={Number.isFinite(end)?end:''} onChange={e=>setEnd(e.target.valueAsNumber)}/></CreativeField></div>
              <CreativeField label={text('片段标题','Clip title')}><Input disabled={disabled} value={title} maxLength={200} onChange={e=>setTitle(e.target.value)} placeholder={source.name}/></CreativeField>
              <p className={hintClass}>{text('按原片时间选段，单段最多 600 秒。音频片段将使用波形封面。','Choose source timestamps, up to 600 seconds per range. Audio clips use a waveform cover.')}</p>
              <div className="flex flex-wrap gap-2"><Button size="sm" disabled={!canRun || !validRange || ranges.length >= 200} onClick={()=>setRanges(value=>[...value,currentRange])}>{text('加入选段列表','Queue range')}</Button><Button size="sm" variant="primary" disabled={!canRun || (!ranges.length && !validRange)} onClick={()=>run({sourceId:source.id,selections:ranges.length?ranges:[currentRange]})}>{text('添加到画面编排','Add ranges to shots')}</Button></div>
              {ranges.length>0 && <ol className="max-h-40 space-y-2 overflow-y-auto">{ranges.map((range,i)=><li key={i} className="flex items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate">{range.start}–{range.end}s · {range.title}</span><Button size="sm" aria-label={`${text('移除选段','Remove range')} ${i+1}`} disabled={disabled} onClick={()=>setRanges(value=>value.filter((_,n)=>n!==i))}><Trash2 size={12}/></Button></li>)}</ol>}
              <div className="border-t border-outline pt-3"><MediaUpload accept=".srt" label={text('按 SRT 时码编排','Arrange using SRT')} disabled={!canRun} onFile={file=>{void file.text().then(srt=>run({sourceId:source.id,srt})).catch(()=>setLocalError(text('无法读取字幕文件','Cannot read subtitle file'))) }}/><p className={`${hintClass} mt-2`}>{text('按字幕时码添加画面并保留原片空白段；字幕翻译在声音与字幕步骤进行。','Add timed caption shots, preserving source gaps. Translate in Sound & captions.')}</p></div>
            </>}
          </div>
        </div>
      </div>}
    </CreativeSection>
  </>
}
