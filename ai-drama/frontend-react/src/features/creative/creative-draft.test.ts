import { describe, expect, it } from 'vitest'
import { hasCreativeActivity, toCreativeDraft, type CreativeProject, type CreativeShot } from '@/entities/creative/model'
import { mergeCreativeMedia, moveCreativeShot, shotHasMedia, validateCreativeDraft } from './creative-draft'

const shot: CreativeShot = { id: 'one', title: 'Opening', duration: 5, visualPrompt: 'A forest', narration: '', caption: '', mediaType: 'image', imageUrl: null, videoUrl: null, imageTaskId: null, videoTaskId: null, trimStart: 0, originalVolume: 1 }
const project: CreativeProject = { id: 1, title: 'Forest', category: 'explainer', style: 'realistic', aspectRatio: '16:9', revision: 1, approvedRevision: 1, brief: { idea: 'A forest', audience: '', tone: '', targetDuration: 30, language: 'en' }, plan: { summary: '', script: '', musicDirection: '' }, shots: [shot], audio: { narrationUrl: null, musicUrl: null, musicVolume: 0.3, burnSubtitles: false }, renders: [], updatedAt: '2026-10-15T00:00:00Z' }

describe('creative video drafts', () => {
  it('keeps runtime task objects out of editable data', () => {
    const draft = toCreativeDraft({ ...project, shots: [{ ...shot, imageTask: { id: 2, status: 'processing', errorMsg: null, localPath: null } }] })
    expect(draft.shots[0].imageTask).toBeUndefined()
    draft.brief.idea = 'Edited'
    expect(project.brief.idea).toBe('A forest')
  })

  it('preserves a generation completed while unrelated text was being edited', () => {
    const baseline = toCreativeDraft(project)
    const edited = { ...baseline, title: 'New title' }
    const latest = { ...project, shots: [{ ...shot, imageUrl: '/static/images/new.png', imageTaskId: 2 }] }
    expect(mergeCreativeMedia(edited, baseline, latest).shots[0]).toMatchObject({ imageUrl: '/static/images/new.png', imageTaskId: 2 })
    expect(mergeCreativeMedia(edited, baseline, latest).title).toBe('New title')
  })

  it('keeps an explicit uploaded replacement instead of a generated image', () => {
    const baseline = toCreativeDraft(project)
    const edited = { ...baseline, shots: [{ ...shot, imageUrl: '/static/uploads/my.png' }] }
    const latest = { ...project, shots: [{ ...shot, imageUrl: '/static/images/generated.png', imageTaskId: 2 }] }
    expect(mergeCreativeMedia(edited, baseline, latest).shots[0]).toMatchObject({ imageUrl: '/static/uploads/my.png', imageTaskId: null })
  })

  it('reorders shots without changing other shots or wrapping at the bounds', () => {
    const shots = [shot, { ...shot, id: 'two' }, { ...shot, id: 'three' }]
    expect(moveCreativeShot(shots, 'one', -1)).toBe(shots)
    expect(moveCreativeShot(shots, 'three', 1)).toBe(shots)
    expect(moveCreativeShot(shots, 'two', 1).map((item) => item.id)).toEqual(['one', 'three', 'two'])
    expect(shots.map((item) => item.id)).toEqual(['one', 'two', 'three'])
  })

  it('requires the chosen media type rather than accepting an image for a video shot', () => {
    expect(shotHasMedia({ ...shot, imageUrl: '/static/a.png', mediaType: 'video' })).toBe(false)
    expect(shotHasMedia({ ...shot, imageUrl: '/static/a.png' })).toBe(true)
  })

  it('rejects invalid durations and out-of-range audio before saving', () => {
    const draft = toCreativeDraft(project)
    expect(validateCreativeDraft(draft)).toBe(true)
    expect(validateCreativeDraft({ ...draft, shots: [{ ...shot, duration: NaN }] })).toBe(false)
    expect(validateCreativeDraft({ ...draft, shots: [{ ...shot, duration: 601 }] })).toBe(false)
    expect(validateCreativeDraft({ ...draft, shots: Array.from({ length: 121 }, (_, i) => ({ ...shot, id: String(i), duration: 30 })) })).toBe(false)
    expect(validateCreativeDraft({ ...draft, audio: { ...draft.audio, musicVolume: 2 } })).toBe(false)
  })

  it('retains shot tool plans and rejects incomplete automation settings before saving', () => {
    const toolPlan = { toolId: 'diagram_render', args: { title: 'Ecosystem' }, reason: 'Explain the relationship' }
    const draft = toCreativeDraft({ ...project, shots: [{ ...shot, toolPlan }] })
    expect(draft.shots[0].toolPlan).toEqual(toolPlan)
    expect(mergeCreativeMedia({ ...draft, title: 'Edited' }, draft, project).shots[0].toolPlan).toEqual(toolPlan)
    expect(validateCreativeDraft({ ...draft, production: { sources: [], fields: { automation: '{"visual":' } } })).toBe(false)
    expect(validateCreativeDraft({ ...draft, production: { sources: [], fields: { automation: '{"visual":"math","musicTool":"off"}' } } })).toBe(true)
  })

  it('polls for active generation and rendering but stops for terminal failures', () => {
    expect(hasCreativeActivity(project)).toBe(false)
    expect(hasCreativeActivity({ ...project, shots: [{ ...shot, videoTask: { id: 2, status: 'processing', errorMsg: null, localPath: null } }] })).toBe(true)
    expect(hasCreativeActivity({ ...project, shots: [{ ...shot, videoTask: { id: 2, status: 'failed', errorMsg: 'Failed', localPath: null } }] })).toBe(false)
    expect(hasCreativeActivity({ ...project, renders: [{ id: 1, status: 'processing', progress: 20, duration: null, errorMsg: null, warnings: [], videoUrl: null, subtitleUrl: null, createdAt: '', revision: 1 }] })).toBe(true)
  })
})
