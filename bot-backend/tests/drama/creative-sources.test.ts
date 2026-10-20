import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createCreativeDocument, creativeDocumentSchema, parseGeneratedPlan } from '../../src/drama/services/creative-model.js'
import { creativeCatalog, publicCreativeCatalog } from '../../src/drama/services/creative-catalog.js'
import { parseCreativeSrt, sourceSelectionsToShots } from '../../src/drama/services/creative-sources.js'
import { parseCaptionTranslation } from '../../src/drama/services/creative-planner.js'
import type { CreativeProject } from '../../src/drama/services/creative-projects.js'

function sourceProject(kind: 'audio' | 'video' = 'video') {
  const document = createCreativeDocument('localization')
  document.brief.targetDuration = 5
  const source = { id: randomUUID(), name: '原片', kind, duration: 5, url: `/static/uploads/source.${kind === 'audio' ? 'wav' : 'mp4'}`, coverUrl: kind === 'audio' ? '/static/creative/1/cover.png' : null, transcript: '', attribution: '' }
  document.production.sources = [source]
  return { ...document, id: 1, revision: 1 } as CreativeProject
}

test('catalog covers every production flow with fields, steps and no server prompt leakage', () => {
  assert.equal(creativeCatalog.length, 12)
  assert.equal(new Set(creativeCatalog.map(item => item.id)).size, 12)
  for (const recipe of creativeCatalog) {
    assert.ok(recipe.fields.length >= 2 && recipe.steps.length >= 3 && recipe.guidance)
    assert.ok(recipe.title.zh && recipe.title.en)
    assert.equal(createCreativeDocument(recipe.id).brief.targetDuration, recipe.duration)
  }
  assert.ok(publicCreativeCatalog().every(recipe => !('guidance' in recipe)))
  const old = createCreativeDocument()
  const { production, ...legacy } = old
  assert.deepEqual(creativeDocumentSchema.parse(legacy).production, {fields: {}, sources: []})
})

await test('SRT import preserves gaps, source offsets and total duration', async () => {
  const project = sourceProject()
  const ranges = parseCreativeSrt('1\n00:00:01,000 --> 00:00:02,000\n<b>第一句</b>\n\n2\n00:00:03,000 --> 00:00:04,000\n第二句')
  const shots = sourceSelectionsToShots(project, project.production.sources[0].id, ranges, true)
  assert.deepEqual((await shots).map(s => [s.trimStart, s.duration, s.caption]), [[0,1,''],[1,1,'第一句'],[2,1,''],[3,1,'第二句'],[4,1,'']])
  assert.ok((await shots).every(s => s.videoUrl === project.production.sources[0].url))
  assert.equal(new Set((await shots).map(s => s.id)).size, 5)
  assert.throws(() => parseCreativeSrt('1\n00:00:02,000 --> 00:00:01,000\n错误'), /时码/)
  assert.throws(() => parseCreativeSrt('1\n00:61:00,000 --> 00:62:00,000\n错误'), /时间/)
  assert.throws(() => sourceSelectionsToShots(project, project.production.sources[0].id, [{start:4,end:6,title:'越界',caption:''}]), /超出/)
  assert.throws(() => sourceSelectionsToShots(project, randomUUID(), ranges), /不存在/)
})

await test('podcast excerpts retain independently trimmed audio and waveform cover', async () => {
  const project = sourceProject('audio'), source = project.production.sources[0]
  const [shot] = (await sourceSelectionsToShots(project, source.id, [{start:2,end:4,title:'观点',caption:'原话'}]))
  assert.equal(shot.audioUrl, source.url)
  assert.equal(shot.audioTrimStart, 2)
  assert.equal(shot.imageUrl, source.coverUrl)
  assert.equal(shot.mediaType, 'image')
  assert.equal(shot.duration, 2)
})

test('planning resolves known source IDs server-side and rejects invented or out-of-bounds ranges', () => {
  const project = sourceProject('audio'), source = project.production.sources[0]
  const plan = { summary:'摘要',script:'原稿',musicDirection:'',shots:[{title:'原声',duration:5,sourceId:source.id,trimStart:0,visualPrompt:'波形封面',narration:'',caption:'字幕',mediaType:'image'}] }
  const result = parseGeneratedPlan(JSON.stringify(plan), project)
  assert.equal(result.shots[0].audioUrl, source.url)
  assert.equal(result.shots[0].imageUrl, source.coverUrl)
  assert.throws(() => parseGeneratedPlan(JSON.stringify({...plan,shots:[{...plan.shots[0],sourceId:randomUUID()}]}),project), /不存在/)
  assert.throws(() => parseGeneratedPlan(JSON.stringify({...plan,shots:[{...plan.shots[0],trimStart:2}]}),project), /超出/)
})

await test('caption translation changes only text and retains original identity, media and timing', async () => {
  const project = (await sourceProject())
  (await project).shots = sourceSelectionsToShots(project, (await project).production.sources[0].id, [{start:1,end:4,title:'原片',caption:'原话'}])
  const translated = parseCaptionTranslation(JSON.stringify([{id:project.shots[0].id,caption:'Translation',narration:''}]), project)
  assert.deepEqual(translated.shots[0], {...(await project).shots[0],caption:'Translation'})
  assert.throws(() => parseCaptionTranslation('[]', project), /缺少/)
  assert.throws(() => parseCaptionTranslation(JSON.stringify([{id:'invented',caption:'x',narration:''}]), project), /未知/)
  assert.throws(() => parseCaptionTranslation(JSON.stringify([{id:project.shots[0].id,caption:'x',narration:'',duration:1}]), project))
})
