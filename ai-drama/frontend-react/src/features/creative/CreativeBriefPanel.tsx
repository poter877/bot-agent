import type { CreativeDraft } from '@/entities/creative/model'
import { Input, Textarea } from '@/shared/ui/input'
import { BaseSelect } from '@/shared/ui/BaseSelect'
import { CreativeField, CreativeSection } from './CreativeFields'
import type { CreativeCopy } from './creative-locales'

export function CreativeBriefPanel({ draft, copy, disabled, onChange }: {
  draft: CreativeDraft
  copy: CreativeCopy
  disabled: boolean
  onChange: (update: (draft: CreativeDraft) => CreativeDraft) => void
}) {
  const updateBrief = (key: keyof CreativeDraft['brief'], value: string | number) => onChange((current) => ({ ...current, brief: { ...current.brief, [key]: value } }))
  const language = draft.brief.language.toLowerCase().startsWith('zh') ? 'zh-CN' : draft.brief.language.split('-')[0]

  return <div className="flex flex-col gap-4">
    <CreativeSection title={copy.brief}>
      <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-4 border-0 p-0">
        <CreativeField label={copy.projectName}><Input value={draft.title} maxLength={200} onChange={(event) => onChange((current) => ({ ...current, title: event.target.value }))} /></CreativeField>
        <CreativeField label={copy.idea}><Textarea rows={5} value={draft.brief.idea} placeholder={copy.ideaPlaceholder} onChange={(event) => updateBrief('idea', event.target.value)} /></CreativeField>
        <div className="grid gap-4 sm:grid-cols-2">
          <CreativeField label={copy.audience}><Input value={draft.brief.audience} onChange={(event) => updateBrief('audience', event.target.value)} /></CreativeField>
          <CreativeField label={copy.tone}><Input value={draft.brief.tone} onChange={(event) => updateBrief('tone', event.target.value)} /></CreativeField>
          <CreativeField label={copy.targetDuration}><Input type="number" min={5} max={3600} value={Number.isFinite(draft.brief.targetDuration) ? draft.brief.targetDuration : ''} onChange={(event) => updateBrief('targetDuration', event.target.valueAsNumber)} /></CreativeField>
          <CreativeField label={copy.language}><BaseSelect disabled={disabled} searchable={false} value={language} onChange={(value) => updateBrief('language', value)} options={[
            { value: 'zh-CN', label: '中文' }, { value: 'en', label: 'English' }, { value: 'ja', label: '日本語' }, { value: 'ko', label: '한국어' },
          ]} /></CreativeField>
        </div>
      </fieldset>
    </CreativeSection>
    
  </div>
}
