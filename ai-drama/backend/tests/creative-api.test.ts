import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'

// Every request and provider stub below uses disposable storage; no real models or user database.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-factory-creative-api-'))
process.env.SQLITE_PATH = path.join(directory, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = directory
process.env.STORAGE_PATH = path.join(directory, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
fs.mkdirSync(path.join(directory, 'static', 'uploads'), { recursive: true })
fs.writeFileSync(path.join(directory, 'static', 'uploads', 'fixture.png'), Buffer.from('test fixture'))
const { db, schema, getInsertId } = await import('../src/db/index.js')
const { default: dramas } = await import('../src/routes/dramas.js')
const { createCreativeRoutes } = await import('../src/routes/creative.js')
const { getCreativeProject, saveCreativeProject, recoverCreativeRenders } = await import('../src/services/creative-projects.js')
const { parseGeneratedPlan, createCreativeDocument } = await import('../src/services/creative-model.js')
const { initSqliteSchema } = await import('../src/db/sqlite-schema.js')
after(() => { db.$client.close(); fs.rmSync(directory, { recursive: true, force: true }) })

type Dependencies = Parameters<typeof createCreativeRoutes>[0]
function appWith(dependencies: Dependencies = {}) {
  return new Hono().route('/dramas', dramas).route('/creative', createCreativeRoutes(dependencies))
}
async function request(app: Hono, url: string, method = 'GET', body?: unknown) {
  const response = await app.request(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, ...(await response.json() as { data: any; message: string }) }
}
async function create(app: Hono, title = '创意测试') {
  const res = await request(app, '/dramas', 'POST', { title, project_type: 'creative', creative_category: 'explainer', aspect_ratio: '16:9' })
  assert.equal(res.status, 201)
  return getCreativeProject(res.data.id)
}
function shot(id = 'first') {
  return { id, title: '开场', duration: 5, visualPrompt: '暖色光中的地球', narration: '地球的一天', caption: '地球的一天',
    mediaType: 'image' as const, imageUrl: '/static/uploads/fixture.png', videoUrl: null, imageTaskId: null, videoTaskId: null, trimStart: 0, originalVolume: 1 }
}
function stubTask(kind: string, projectId: number) {
  return getInsertId(db.insert(schema.sysTask).values({ type: kind, dramaId: projectId, status: 'processing', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run())
}

test('creation persists project kind and creative document atomically without creating an episode', async () => {
  const app = appWith()
  const project = await create(app)
  assert.equal(project.category, 'explainer')
  assert.equal(project.revision, 1)
  assert.equal(project.audio.burnSubtitles, false)
  assert.equal(db.select().from(schema.episodes).where(eq(schema.episodes.dramaId, project.id)).all().length, 0)
  const ordinary = await request(app, '/dramas', 'POST', { title: '旧短剧入口' })
  assert.equal(ordinary.data.project_type, 'drama')
  assert.equal((await request(app, `/creative/${ordinary.data.id}`)).status, 404)
  assert.equal((await request(app, '/dramas', 'POST', { title: '缺类别', project_type: 'creative' })).status, 400)
  assert.equal((await request(app, `/dramas/${project.id}/episodes`, 'PUT', { episodes: [{ title: '不应该存在' }] })).status, 400)
  assert.throws(() => db.insert(schema.episodes).values({ dramaId: project.id, title: '不应创建', episodeNumber: 1, createdAt: '', updatedAt: '' }).run(), /创意视频项目不使用剧集/)
})

test('old databases acquire project discriminator idempotently and preserve old rows', () => {
  const old = new Database(':memory:')
  old.exec(`CREATE TABLE dramas(id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT, genre TEXT, style TEXT,
    aspect_ratio TEXT, total_episodes INTEGER, total_duration INTEGER, status TEXT, thumbnail TEXT, tags TEXT, metadata TEXT,
    created_at TEXT, updated_at TEXT, deleted_at TEXT); INSERT INTO dramas(id,title) VALUES (7,'existing')`)
  initSqliteSchema(old)
  initSqliteSchema(old)
  assert.deepEqual(old.prepare('SELECT title, project_type, creative_category FROM dramas WHERE id=7').get(), { title: 'existing', project_type: 'drama', creative_category: null })
  old.close()
})

test('saving validates media, durations and unique shots; optimistic conflicts preserve approved content', async () => {
  const app = appWith()
  const project = await create(app)
  const saved = await request(app, `/creative/${project.id}`, 'PUT', { ...project, shots: [shot()] })
  assert.equal(saved.status, 200)
  assert.equal(saved.data.revision, 2)
  assert.equal((await request(app, `/creative/${project.id}/approve`, 'POST', { revision: 2 })).data.approvedRevision, 2)
  assert.equal((await request(app, `/creative/${project.id}`, 'PUT', project)).status, 409)
  for (const changes of [
    { shots: [shot(), shot()] }, { shots: [{ ...shot(), duration: -1 }] },
    { shots: [{ ...shot(), imageUrl: 'http://127.0.0.1/private.png' }] },
    { shots: [{ ...shot(), imageUrl: '/static/uploads/../../secret.png' }] },
    { shots: [{ ...shot(), imageTaskId: 987 }] },
  ]) assert.equal((await request(app, `/creative/${project.id}`, 'PUT', { ...saved.data, ...changes })).status, 400)
  const renamed = await request(app, `/creative/${project.id}`, 'PUT', { ...saved.data, title: '新标题' })
  assert.equal(renamed.data.revision, 3)
  assert.equal(renamed.data.title, '新标题')
  assert.equal(renamed.data.approvedRevision, null)
  assert.equal((await request(app, `/dramas/${project.id}`, 'PUT', { title: '绕开版本' })).status, 400)
  assert.equal((await request(app, `/dramas/${project.id}`, 'PUT', { status: 'completed' })).status, 200)
})

test('symlink and another project generated media cannot be attached', async () => {
  const app = appWith()
  const first = await create(app), second = await create(app)
  fs.mkdirSync(path.join(directory, 'static', 'images'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'static', 'images', 'other.png'), 'fixture')
  db.insert(schema.sysTask).values({ dramaId: first.id, type: 'image', localPath: 'static/images/other.png', status: 'completed', createdAt: '', updatedAt: '' }).run()
  const foreign = await request(app, `/creative/${second.id}`, 'PUT', { ...second, shots: [{ ...shot(), imageUrl: '/static/images/other.png' }] })
  assert.equal(foreign.status, 400)
  fs.writeFileSync(path.join(directory, 'outside.png'), 'private')
  fs.symlinkSync(path.join(directory, 'outside.png'), path.join(directory, 'static', 'uploads', 'outside.png'))
  assert.equal((await request(app, `/creative/${second.id}`, 'PUT', { ...second, shots: [{ ...shot(), imageUrl: '/static/uploads/outside.png' }] })).status, 400)
})

test('generation requires review, deduplicates running task and keeps result state outside content revision', async () => {
  let calls = 0
  let parameters: any
  const app = appWith({ generateImage: async params => { calls++; parameters = params; return stubTask('image', params.dramaId!) } })
  let project = await create(app)
  project = saveCreativeProject(project.id, { ...project, shots: [{ ...shot(), imageUrl: null }] })
  const generate = () => request(app, `/creative/${project.id}/shots/first/generate`, 'POST', { revision: project.revision, kind: 'image' })
  assert.equal((await generate()).status, 409)
  await request(app, `/creative/${project.id}/approve`, 'POST', { revision: project.revision })
  const [a, b] = await Promise.all([generate(), generate()])
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(calls, 1)
  assert.equal(parameters.dramaId, project.id)
  assert.equal(parameters.storyboardId, undefined)
  assert.equal((await request(app, `/creative/${project.id}`, 'PUT', project)).status, 409)
  const taskId = a.data.shots[0].imageTaskId
  db.update(schema.sysTask).set({ status: 'completed', localPath: 'static/uploads/fixture.png' }).where(eq(schema.sysTask.id, taskId)).run()
  const complete = getCreativeProject(project.id)
  assert.equal(complete.shots[0].imageUrl, '/static/uploads/fixture.png')
  assert.equal(complete.shots[0].imageTask.status, 'completed')
  assert.equal(complete.revision, project.revision)
  // A stale draft with null media cannot clear a task that just completed.
  const resaved = saveCreativeProject(project.id, { ...project, plan: { ...project.plan, summary: '只修改摘要' } })
  assert.equal(resaved.shots[0].imageUrl, '/static/uploads/fixture.png')
  assert.equal(resaved.shots[0].imageTaskId, taskId)
  const changedShot = saveCreativeProject(project.id, { ...resaved, shots: [{ ...resaved.shots[0], visualPrompt: '不同的画面' }] })
  assert.equal(changedShot.shots[0].imageTaskId, null)
  assert.equal(changedShot.shots[0].imageUrl, null)
})

test('a slow plan response never overwrites edits made while the model was running', async () => {
  let resolvePlan!: (value: any) => void
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const app = appWith({ generateCreativePlan: async () => { started(); return new Promise(resolve => { resolvePlan = resolve }) } })
  let project = await create(app)
  project = saveCreativeProject(project.id, { ...project, brief: { ...project.brief, idea: '解释昼夜' } })
  const pending = request(app, `/creative/${project.id}/plan`, 'POST', { revision: project.revision })
  await entered
  const edited = saveCreativeProject(project.id, { ...project, plan: { ...project.plan, script: '用户已编辑的文案' } })
  resolvePlan({ ...project, shots: [shot()] })
  assert.equal((await pending).status, 409)
  assert.equal(getCreativeProject(project.id).plan.script, edited.plan.script)
  assert.equal(getCreativeProject(project.id).shots.length, 0)
})

test('uploading replacement media clears a failed generation indicator only for that slot', async () => {
  const app = appWith({ generateImage: async params => stubTask('image', params.dramaId!) })
  let project = await create(app)
  project = saveCreativeProject(project.id, { ...project, shots: [{ ...shot(), imageUrl: null }] })
  await request(app, `/creative/${project.id}/approve`, 'POST', { revision: project.revision })
  const generated = await request(app, `/creative/${project.id}/shots/first/generate`, 'POST', { revision: project.revision, kind: 'image' })
  db.update(schema.sysTask).set({ status: 'failed', errorMsg: 'fixture failure' }).where(eq(schema.sysTask.id, generated.data.shots[0].imageTaskId)).run()
  const updated = saveCreativeProject(project.id, { ...getCreativeProject(project.id), shots: [shot()] })
  assert.equal(updated.shots[0].imageUrl, '/static/uploads/fixture.png')
  assert.equal(updated.shots[0].imageTaskId, null)
  assert.equal(updated.shots[0].imageTask, undefined)
})

test('video generation uses the saved reference image and rejects unsupported durations before charging a provider', async () => {
  let parameters: any
  let calls = 0
  const configId = getInsertId(db.insert(schema.aiServiceConfigs).values({
    name: 'Test H3', serviceType: 'video', provider: 'minimax', baseUrl: 'https://invalid.example',
    apiKey: 'not-a-real-key', model: JSON.stringify(['MiniMax-H3']), isActive: true, createdAt: '', updatedAt: '',
  }).run())
  const app = appWith({ generateVideo: async params => { calls++; parameters = params; return stubTask('video', params.dramaId!) } })
  let project = await create(app)
  project = saveCreativeProject(project.id, { ...project, shots: [{ ...shot(), duration: 5.5, mediaType: 'video' }] })
  await request(app, `/creative/${project.id}/approve`, 'POST', { revision: project.revision })
  const generated = await request(app, `/creative/${project.id}/shots/first/generate`, 'POST', { revision: project.revision, kind: 'video', configId })
  assert.equal(generated.status, 200)
  assert.equal(parameters.firstFrameUrl, '/static/uploads/fixture.png')
  assert.equal(parameters.duration, 6)
  assert.equal(parameters.generateAudio, true)
  assert.equal(parameters.storyboardId, undefined)
  db.update(schema.sysTask).set({ status: 'failed' }).where(eq(schema.sysTask.id, generated.data.shots[0].videoTaskId)).run()
  project = saveCreativeProject(project.id, { ...getCreativeProject(project.id), shots: [{ ...shot(), mediaType: 'video', duration: 30 }] })
  await request(app, `/creative/${project.id}/approve`, 'POST', { revision: project.revision })
  const tooLong = await request(app, `/creative/${project.id}/shots/first/generate`, 'POST', { revision: project.revision, kind: 'video', configId })
  assert.equal(tooLong.status, 400)
  assert.match(tooLong.message, /15 秒/)
  assert.equal(calls, 1)
})

test('malformed model outputs and duration mismatch fail instead of inventing a fallback plan', () => {
  const document = createCreativeDocument()
  document.brief.targetDuration = 30
  assert.throws(() => parseGeneratedPlan('not JSON', document), /未返回有效/)
  assert.throws(() => parseGeneratedPlan(JSON.stringify({ summary: 'summary', script: '', musicDirection: '', shots: [shot()] }), document), /总时长/)
  const valid = parseGeneratedPlan(JSON.stringify({ summary: 'summary', script: 'text', musicDirection: 'soft', shots: Array.from({ length: 6 }, () => shot()) }), document)
  assert.equal(valid.shots.length, 6)
  assert.equal(new Set(valid.shots.map(s => s.id)).size, 6)
  assert.ok(valid.shots.every(s => !s.imageUrl && !s.videoUrl))
})

test('render freezes approved media, deduplicates active requests and does not pin the project to old content', async () => {
  let calls = 0, received: any
  let finish!: (result: any) => void
  const app = appWith({ renderCreativeVideo: async (input, progress) => { calls++; received = input; progress?.(25); return new Promise(resolve => { finish = resolve }) } })
  let project = await create(app)
  project = saveCreativeProject(project.id, { ...project, shots: [shot()] })
  assert.equal((await request(app, `/creative/${project.id}/render`, 'POST', { revision: project.revision })).status, 409)
  await request(app, `/creative/${project.id}/approve`, 'POST', { revision: project.revision })
  const rendered = await request(app, `/creative/${project.id}/render`, 'POST', { revision: project.revision })
  assert.equal(rendered.status, 200)
  assert.equal(rendered.data.renders[0].progress, 25)
  await request(app, `/creative/${project.id}/render`, 'POST', { revision: project.revision })
  assert.equal(calls, 1)
  saveCreativeProject(project.id, { ...getCreativeProject(project.id), title: '导出期间更改' })
  assert.equal(received.title, project.title)
  finish({ videoUrl: `static/creative/${project.id}/complete.mp4`, subtitleUrl: null, duration: 5, width: 1280, height: 720, warnings: [] })
  await new Promise(resolve => setTimeout(resolve, 10))
  const done = getCreativeProject(project.id)
  assert.equal(done.title, '导出期间更改')
  assert.equal(done.renders[0].status, 'completed')
  assert.equal(done.renders[0].revision, project.revision)
  assert.equal(done.renders[0].videoUrl, `/static/creative/${project.id}/complete.mp4`)
  assert.ok(done.renders[0].warnings.some((message: string) => message.includes('旁白')))
})

test('missing selected media and deleted projects fail explicitly; interrupted renders become retryable failures', async () => {
  const app = appWith()
  let project = await create(app)
  project = saveCreativeProject(project.id, { ...project, shots: [{ ...shot(), mediaType: 'video' }] })
  await request(app, `/creative/${project.id}/approve`, 'POST', { revision: project.revision })
  assert.equal((await request(app, `/creative/${project.id}/render`, 'POST', { revision: project.revision })).status, 400)
  const jobId = getInsertId(db.insert(schema.creativeRenders).values({ projectId: project.id, revision: project.revision, snapshot: '{}', status: 'processing', createdAt: '' }).run())
  assert.equal(recoverCreativeRenders(), 1)
  const job = db.select().from(schema.creativeRenders).where(eq(schema.creativeRenders.id, jobId)).get()!
  assert.equal(job.status, 'failed')
  assert.match(job.errorMsg!, /重启/)
  await request(app, `/dramas/${project.id}`, 'DELETE')
  assert.equal((await request(app, `/creative/${project.id}`)).status, 404)
})

test('all twelve types create and reload with dedicated production fields; old saves retain sources', async () => {
  const app = appWith()
  const catalog = await request(app, '/creative/catalog')
  assert.equal(catalog.status, 200)
  assert.equal(catalog.data.length, 12)
  for (const recipe of catalog.data) {
    const created = await request(app, '/dramas', 'POST', { title: recipe.title.zh, project_type: 'creative', creative_category: recipe.id })
    assert.equal(created.status, 201)
    const project = getCreativeProject(created.data.id)
    assert.equal(project.category, recipe.id)
    const fields = Object.fromEntries(recipe.fields.map((field: {key:string}) => [field.key, '专属创作要求']))
    const saved = await request(app, `/creative/${project.id}`, 'PUT', {...project,production:{fields,sources:[]}})
    assert.equal(saved.status, 200)
    assert.deepEqual(getCreativeProject(project.id).production.fields, fields)
    const {production, ...legacy} = saved.data
    const legacySave = await request(app, `/creative/${project.id}`, 'PUT', legacy)
    assert.deepEqual(legacySave.data.production.fields, fields)
  }
  assert.equal((await request(app, '/dramas', 'POST', {title:'unknown', project_type:'creative',creative_category:'unknown'})).status,400)
})

test('source-required types stop before calling the model when input is missing', async () => {
  let calls = 0
  const app = appWith({ generateCreativePlan: async () => {calls++; throw new Error('must not be called')} })
  for (const category of ['talking_head','screen_demo','podcast','clip_factory','localization']) {
    const created = await request(app, '/dramas', 'POST', {title:category,project_type:'creative',creative_category:category})
    const project = getCreativeProject(created.data.id)
    const saved = saveCreativeProject(project.id, {...project,brief:{...project.brief,idea:'剪辑原片'}})
    assert.equal((await request(app, `/creative/${project.id}/plan`, 'POST', {revision:saved.revision})).status,400)
  }
  assert.equal(calls, 0)
})

test('batch export records separate outputs and retains completed clips if a later export fails', async () => {
  for (const failSecond of [false, true]) {
    let calls = 0
    const app = appWith({ renderCreativeVideo: async input => {
      calls++
      assert.equal(input.shots.length, 1)
      if (failSecond && calls === 2) throw new Error('第二条处理失败')
      return {videoUrl:`static/creative/${input.projectId}/${input.shots[0].id}.mp4`,subtitleUrl:null,duration:5,width:1280,height:720,warnings:[]}
    } })
    let project = await create(app)
    project = saveCreativeProject(project.id, {...project,shots:[shot('one'),shot('two')]})
    await request(app, `/creative/${project.id}/approve`, 'POST', {revision:project.revision})
    assert.equal((await request(app, `/creative/${project.id}/render`, 'POST', {revision:project.revision,individual:true})).status,200)
    for (let n=0; n<50 && getCreativeProject(project.id).renders[0].status === 'processing'; n++) await new Promise(r=>setTimeout(r,5))
    const job = getCreativeProject(project.id).renders[0]
    assert.equal(calls,2)
    assert.equal(job.status,failSecond?'failed':'completed')
    assert.equal(job.outputs.length,failSecond?1:2)
    assert.equal(job.outputs[0].shotId,'one')
    assert.equal(job.videoUrl,null)
  }
})

test('translation invalidates approval and cannot overwrite a simultaneous edit', async () => {
  let complete!: (document:any)=>void
  const app = appWith({translateCreativeCaptions: async () => new Promise(resolve=>{complete=resolve})})
  let project = await create(app)
  project = saveCreativeProject(project.id,{...project,shots:[shot()]})
  const pending = request(app, `/creative/${project.id}/translate`, 'POST', {revision:project.revision})
  for(let n=0;n<50&&!complete;n++) await new Promise(r=>setTimeout(r,2))
  saveCreativeProject(project.id,{...project,title:'新修改'})
  complete({...project,shots:[{...project.shots[0],caption:'Translation'}]})
  assert.equal((await pending).status,409)
  assert.equal(getCreativeProject(project.id).shots[0].caption,'地球的一天')
})

test('source upload probes real media, protects source metadata and removes invalid uploads', async () => {
  const sharp = (await import('sharp')).default
  const app = appWith()
  let project = await create(app)
  const upload = async (data: Uint8Array, name: string, revision: number) => {
    const body = new FormData()
    body.set('file',new File([data],name))
    return app.request(`/creative/${project.id}/sources/upload?revision=${revision}`,{method:'POST',body})
  }
  const image = await sharp({create:{width:32,height:32,channels:3,background:'blue'}}).png().toBuffer()
  let response = await upload(image,'image.png',project.revision)
  assert.equal(response.status,200)
  project = (await response.json() as any).data
  const source = project.production.sources[0]
  assert.equal(source.kind,'image')
  assert.equal(source.duration,null)
  assert.equal((await request(app,`/creative/${project.id}`,'PUT',{...project,production:{...project.production,sources:[{...source,duration:999}]}})).status,400)
  response = await upload(image,'image.png',1)
  assert.equal(response.status,409)
  const before = fs.readdirSync(path.join(directory,'static','uploads')).sort()
  response = await upload(new TextEncoder().encode('invalid media'),'invalid.mp4',project.revision)
  assert.equal(response.status,503)
  assert.deepEqual(fs.readdirSync(path.join(directory,'static','uploads')).sort(),before)
})

test('retired categories cannot be created but existing projects remain editable', async () => {
  const app = appWith()
  const catalog = (await request(app, '/creative/catalog')).data
  for (const category of ['product', 'montage']) {
    assert.ok(!catalog.some((item: {id:string}) => item.id === category))
    assert.equal((await request(app, '/dramas', 'POST', {title:'retired',project_type:'creative',creative_category:category})).status,400)
    const initial = await create(app)
    // Simulate a project stored by the earlier release without changing its content.
    db.update(schema.dramas).set({creativeCategory:category}).where(eq(schema.dramas.id,initial.id)).run()
    const old = getCreativeProject(initial.id)
    assert.equal(old.category,category)
    assert.equal(old.recipe.id,category)
    assert.ok(!('guidance' in old.recipe))
    const saved = await request(app,`/creative/${old.id}`,'PUT',{...old,title:'旧项目仍可编辑'})
    assert.equal(saved.status,200)
    assert.equal(saved.data.category,category)
    assert.equal(saved.data.title,'旧项目仍可编辑')
  }
})
