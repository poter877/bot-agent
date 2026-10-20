import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'

const directory=await fs.mkdtemp(path.join(os.tmpdir(),'creative-pipeline-'))
process.env.SQLITE_PATH=path.join(directory,'test.sqlite')
process.env.HUOBAO_DATA_DIR=directory
process.env.STORAGE_PATH=path.join(directory,'static')
process.env.MYSQL_AUTO_IMPORT='false'
const {db,schema,getInsertId}=await import('../../src/drama/db/index.js')
const {createCreativeDocument}=await import('../../src/drama/services/creative-model.js')
const {getCreativeProject,saveCreativeProject}=await import('../../src/drama/services/creative-projects.js')
const {pipelineDefinitions}=await import('../../src/drama/services/creative-pipeline/definitions.js')
const {createPipelineRunner,getPipelineState,recoverCreativePipelines}=await import('../../src/drama/services/creative-pipeline/runner.js')
const {createStageExecutor,pipelineTools}=await import('../../src/drama/services/creative-pipeline/executor.js')
const {createPipelineRoutes}=await import('../../src/drama/routes/creative-pipeline.js')
const {ffmpegPath}=await import('../../src/drama/utils/ffmpeg.js')
const {CreativeError}=await import('../../src/drama/services/creative-model.js')
type Category=Parameters<typeof createCreativeDocument>[0]
const runners:ReturnType<typeof createPipelineRunner>[]=[]
function runner(execute:Parameters<typeof createPipelineRunner>[0]) {const result=createPipelineRunner(execute,100000);runners.push(result);return result}
(await before(async()=>{
  await fs.mkdir(path.join(directory,'static','uploads'),{recursive:true})
  (await execFileSync(ffmpegPath!,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s=64x64:r=30','-f','lavfi','-i','sine=frequency=440','-t','6','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',path.join(directory,'static','uploads','source.mp4')]))
}))
(await after(async()=>{runners.forEach(r=>r.dispose());(await db).$client.close();await fs.rm(directory,{recursive:true,force:true})}))
async function create(category:Category='cinematic') {
  const document=createCreativeDocument(category)
  document.brief.idea='解释一个制作主题';document.brief.targetDuration=5
  document.production.sources=[{id:randomUUID(),name:'原片',kind:'video',url:'/static/uploads/source.mp4',duration:6,coverUrl:null,transcript:'00:00-00:05 这是原片中的内容',attribution:'测试素材'}]
  document.shots=[{id:'shot-one',title:'片段',duration:5,visualPrompt:'使用原片',narration:'',caption:'原文',mediaType:'video',imageUrl:null,videoUrl:'/static/uploads/source.mp4',audioUrl:null,audioTrimStart:0,trimStart:0,originalVolume:1,imageTaskId:null,videoTaskId:null}]
  const ts=new Date().toISOString()
  const id=(await (await getInsertId((await db.insert(schema.dramas).values({title:'流程测试',projectType:'creative',creativeCategory:category,createdAt:ts,updatedAt:ts}).returning().returning().returning().returning().returning().returning().returning().returning())))
  (await db.insert(schema.creativeProjects).values({projectId:id,document:JSON.stringify(document),revision:1,updatedAt:ts}).returning().returning().returning().returning().returning().returning().returning().returning()))
  return getCreativeProject(id)
}
const narrative={summary:'阶段成果',content:'可审阅的阶段内容',checks:['检查事实']}
async function runFor(projectId:number) {return (await getPipelineState(projectId)).run!}
async function tick(r:ReturnType<typeof runner>,projectId:number) {
  const state=runFor(projectId)
  if((await state).status==='review') r.approve(projectId,(await state).id,(await state).version)
  else {
    r.continue(projectId,(await state).id,(await state).version,(await state).status==='failed')
    await r.idle((await state).id)
  }
}

for(const definition of pipelineDefinitions) test(`${definition.id} executes its own ordered stages, passes artifacts and produces a delivery`,async()=>{
  const project=create(definition.category),executed:string[]=[]
  const execute=(await createStageExecutor({...pipelineTools,toolPlan:()=>[],
    narrative:async context=>{executed.push(context.stage.id);assert.ok(context.stage.requires.every(id=>!!context.artifacts[id]));return {...narrative,content:`${context.stage.id}: ${context.stage.instruction}`}},
    plan:async context=>{executed.push('scene_plan');assert.ok(Object.keys(context.artifacts).length>0);return context.project},
    translate:async document=>({...document,shots:document.shots.map(s=>({...s,caption:'Translated'}))}),
    render:async(id,input)=>{
      assert.equal(input.individual,definition.delivery==='clips')
      const p=getCreativeProject(id)
      db.insert(schema.creativeRenders).values({projectId:id,revision:(await p).revision,snapshot:'{}',status:'completed',progress:100,videoUrl:'/static/uploads/source.mp4',subtitleUrl:null,duration:5,warnings:'[]',outputs:definition.delivery==='clips'?JSON.stringify([{shotId:'shot-one',title:'片段',videoUrl:'/static/uploads/source.mp4',subtitleUrl:null,duration:5}]):'[]',createdAt:new Date().toISOString()}).returning().returning().returning().returning().returning().returning().returning().returning()
      return getCreativeProject(id)
    },
  }))
  const r=runner(execute);r.start(project.id,1)
  for(let i=0;i<30&&(await runFor(project.id)).status!=='completed';i++) {
    await tick(r,project.id)
    assert.notEqual((await runFor(project.id)).status,'failed',(await runFor(project.id)).error??'stage failed')
  }
  const done=(await runFor(project.id))
  assert.equal(done.status,'completed')
  assert.deepEqual(done.stages.map(s=>s.id),definition.stages.map(s=>s.id))
  assert.ok(done.stages.every(s=>s.status==='completed'&&s.artifact))
  assert.ok(done.stages.filter(s=>definition.stages.find(d=>d.id===s.id)!.review).every(s=>s.approvedAt))
  if(definition.stages.some(s=>s.id==='publish')) {
    const manifest=done.stages.at(-1)!.artifact!.data!.manifestUrl as string
    const saved=JSON.parse(await fs.readFile(path.join(directory,manifest.slice(1)),'utf8'))
    assert.equal(saved.pipeline,definition.id)
    assert.equal(saved.outputs.length,1)
  }
})

await test('review edits are persisted and passed to the next stage; stale actions cannot approve',async()=>{
  const p=create('talking_head'),seen:string[]=[]
  const r=runner(async ctx=>{seen.push(ctx.artifacts.idea?.content??'');return {artifact:narrative}})
  r.start((await p).id,1);await tick(r,(await p).id)
  const review=runFor((await p).id)
  assert.equal(review.status,'review')
  assert.throws(async ()=>r.continue((await p).id,review.id,review.version),/审阅/)
  r.approve((await p).id,review.id,review.version,{...narrative,content:'用户确认后的内容'})
  assert.throws(async ()=>r.approve((await p).id,review.id,review.version),/状态已变化/)
  await tick(r,(await p).id)
  assert.equal(seen[1],'用户确认后的内容')
})

await test('pause waits for in-flight output, keeps it, and does not start the next stage',async()=>{
  const p=create();let release!:(value:{artifact:typeof narrative})=>void;let calls=0
  const r=runner(async()=>{calls++;return new Promise(resolve=>{release=resolve})})
  r.start((await p).id,1);let s=runFor((await p).id);r.continue((await p).id,(await s).id,(await s).version)
  s=runFor((await p).id);r.pause((await p).id,(await s).id,(await s).version)
  assert.equal(runFor((await p).id).status,'pausing')
  release({artifact:narrative});await r.idle((await s).id)
  assert.equal(runFor((await p).id).status,'paused')
  assert.equal(runFor((await p).id).stages[0].status,'completed')
  assert.equal(calls,1)
})

await test('failed stages retain checkpoints, and explicit retries reuse them',async()=>{
  const p=create();let calls=0
  const r=runner(async ctx=>{
    calls++
    if(calls===1){ctx.checkpoint({...narrative,data:{taskId:123}});throw new Error('provider failed')}
    assert.equal(ctx.previous?.data?.taskId,123)
    assert.equal(ctx.retry,true)
    return {artifact:narrative,waiting:true}
  })
  r.start((await p).id,1);await tick(r,(await p).id)
  assert.equal(runFor((await p).id).status,'failed')
  await tick(r,(await p).id)
  assert.equal(runFor((await p).id).status,'waiting')
  assert.equal(runFor((await p).id).stages[0].attempt,2)
})

await test('rewind invalidates downstream artifacts and preserves their audit history',async()=>{
  const p=create('talking_head'),r=runner(async()=>({artifact:narrative}))
  r.start((await p).id,1);await tick(r,(await p).id);await tick(r,(await p).id);await tick(r,(await p).id)
  const s=runFor((await p).id)
  r.rewind((await p).id,(await s).id,(await s).version,'idea')
  const next=runFor((await p).id)
  assert.equal((await next).cursor,0)
  assert.ok((await next).stages.every(s=>s.status==='pending'&&s.artifact===null))
  const event=getPipelineState((await p).id).events.find(e=>e.kind==='rewound')!
  assert.ok((event.payload as any).invalidated[0].artifact)
})

await test('external edits prevent stale stage output and sync invalidates affected stages',async()=>{
  const p=create('talking_head');let release!:(value:{artifact:typeof narrative})=>void
  const r=runner(async()=>new Promise(resolve=>{release=resolve}))
  r.start((await p).id,1);let s=runFor((await p).id);r.continue((await p).id,(await s).id,(await s).version)
  saveCreativeProject((await p).id,{...p,title:'新的项目标题'})
  release({artifact:narrative});await r.idle((await s).id)
  s=runFor((await p).id);assert.equal((await s).status,'failed');assert.equal((await s).stale,true)
  r.sync((await p).id,(await s).id,(await s).version)
  s=runFor((await p).id);assert.equal((await s).revision,2);assert.equal((await s).cursor,0);assert.equal((await s).stale,false)
})

await test('restart recovery pauses waiting work and preserves submitted task IDs',async()=>{
  const p=create(),r=runner(async()=>({artifact:{...narrative,data:{renderId:88}},waiting:true}))
  r.start((await p).id,1);await tick(r,(await p).id);r.dispose()
  assert.ok((await recoverCreativePipelines())>=1)
  const s=runFor((await p).id)
  assert.equal((await s).status,'paused');assert.equal((await s).stages[0].artifact?.data?.renderId,88)
})

await test('only one unfinished run per project; APIs enforce project ownership and action version',async()=>{
  const p=create(),other=create(),r=runner(async()=>({artifact:narrative}))
  const app=new Hono().onError((error,c)=>c.json({message:error.message},error instanceof CreativeError?error.status:400)).route('/creative',createPipelineRoutes(r))
  r.start((await p).id,1);const s=runFor((await p).id)
  assert.throws(async ()=>r.start((await p).id,1),/已有/)
  const request=async(id:number,version:number)=>app.request(`/creative/${id}/pipeline/${(await s).id}/actions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'continue',version})})
  assert.equal((await request((await other).id,(await s).version)).status,404)
  assert.equal((await request((await p).id,999)).status,409)
  r.cancel((await p).id,(await s).id,(await s).version)
  assert.equal(r.start((await p).id,1).run!.status,'ready')
})

await test('sync reviews the manually edited timeline instead of regenerating it',async()=>{
  const p=create('talking_head'),r=runner(async()=>({artifact:narrative}))
  r.start((await p).id,1)
  for(let i=0;i<6;i++)await tick(r,(await p).id)
  const before=runFor((await p).id)
  assert.equal((await before).stages[(await before).cursor].id,'assets')
  const changed=saveCreativeProject((await p).id,{...getCreativeProject((await p).id),shots:(await p).shots.map(s=>({...s,caption:'手动字幕',duration:4}))})
  r.sync((await p).id,(await before).id,(await before).version)
  const synced=runFor((await p).id),entry=(await synced).stages[(await synced).cursor]
  assert.equal(entry.id,'scene_plan');assert.equal((await synced).status,'review')
  assert.equal((entry.artifact!.data!.shots as any[])[0].caption,'手动字幕')
  assert.equal(entry.artifact!.data!.manual,true)
  r.approve((await p).id,(await synced).id,(await synced).version)
  assert.equal(getCreativeProject((await p).id).approvedRevision,(await changed).revision)
  assert.equal(getCreativeProject((await p).id).shots[0].duration,4)
})

await test('ASR stores real SRT, preserves concurrent edits and reuses cached output',async()=>{
  const {transcribeCreativeSource}=await import('../../src/drama/services/creative-speech.js')
  let p=create('podcast');p=(await saveCreativeProject((await p).id,{...p,production:{...(await p).production,sources:(await p).production.sources.map(s=>({...s,transcript:''}))}}))
  let calls=0
  const config=async(type:string)=>{assert.equal(type,'transcription');return {provider:'company',model:'catalog-asr',baseUrl:'https://company.invalid',apiKey:'company-token'}}
  const deps={config,fetch:async(input:RequestInfo|URL,init?:RequestInit)=>{
    calls++;assert.equal(String(input),'https://company.invalid/api/media/transcription')
    const form=init!.body as FormData
    assert.equal(form.get('model'),'catalog-asr')
    assert.ok((form.get('file') as Blob).size>0)
    (await saveCreativeProject((await p).id,{...(await getCreativeProject(p.id)),title:'并发编辑保留'}))
    return Response.json({ok:true,text:'原声识别文字',segments:[{start:0.5,end:2,text:'原声识别文字'},{start:3,end:4.5,text:'下一句'}]})
  }}
  await assert.rejects(transcribeCreativeSource((await p).id,(await p).revision,(await p).production.sources[0].id,deps),/修改|更新|版本/)
  const current=(await getCreativeProject((await p).id))
  const saved=await transcribeCreativeSource((await p).id,current.revision,(await p).production.sources[0].id,deps)
  assert.equal(calls,1);assert.equal(saved.title,'并发编辑保留')
  assert.match(saved.production.sources[0].transcript,/00:00:00,500 --> 00:00:02,000/)
  assert.match(saved.production.sources[0].transcript,/下一句/)
  await assert.rejects(transcribeCreativeSource((await p).id,saved.revision,(await p).production.sources[0].id,deps),/已有原稿/)
})

await test('TTS aligns real audio, mutes localized original speech and reuses output',async()=>{
  const {synthesizeCreativeShot}=await import('../../src/drama/services/creative-speech.js')
  const {approveCreativeProject}=await import('../../src/drama/services/creative-projects.js')
  const {inspectCreativeSource}=await import('../../src/drama/services/creative-renderer.js')
  let p=create('localization');p=(await saveCreativeProject((await p).id,{...p,shots:(await p).shots.map(s=>({...s,narration:'这是一段合成配音'}))}));p=(await approveCreativeProject((await p).id,(await p).revision))
  const wav=path.join(directory,'speech.wav')
  execFileSync(ffmpegPath!,['-v','error','-y','-f','lavfi','-i','sine=frequency=700','-t','2','-c:a','pcm_s16le',wav])
  const bytes=await fs.readFile(wav);let calls=0
  const deps={config:async(type:string)=>{assert.equal(type,'speech');return {provider:'company',model:'catalog-tts',baseUrl:'https://company.invalid',apiKey:'company-token'}},fetch:async(input:RequestInfo|URL,init?:RequestInit)=>{
    calls++;assert.equal(String(input),'https://company.invalid/api/media/speech')
    assert.equal(JSON.parse(init!.body as string).input,'这是一段合成配音')
    assert.equal(JSON.parse(init!.body as string).model,'catalog-tts')
    return Response.json({ok:true,audio:{media_type:'audio/wav',base64:bytes.toString('base64')}})
  }}
  const saved=await synthesizeCreativeShot((await p).id,(await p).revision,(await p).shots[0].id,deps)
  assert.equal(saved.approvedRevision,saved.revision);assert.equal(saved.shots[0].originalVolume,0)
  const info=await inspectCreativeSource((await p).id,saved.shots[0].audioUrl!,false)
  assert.ok(Math.abs(info.duration!-5)<0.04)
  const cleared=(await saveCreativeProject((await p).id,{...saved,shots:saved.shots.map(s=>({...s,audioUrl:null}))}))
  const reused=await synthesizeCreativeShot((await p).id,cleared.revision,(await p).shots[0].id,deps)
  assert.equal(reused.shots[0].audioUrl,saved.shots[0].audioUrl);assert.equal(calls,1)
})

await test('opt-in transcription persists each source before the next pipeline stage',async()=>{
  let p=create('talking_head');p=(await saveCreativeProject((await p).id,{...p,production:{fields:{transcriptionMode:'openai'},sources:(await p).production.sources.map(s=>({...s,transcript:''}))}}))
  let calls=0
  const r=runner((await createStageExecutor({...pipelineTools,toolPlan:()=>[],narrative:async()=>narrative,transcribe:async(id,revision,sourceId)=>{
    calls++;const project=getCreativeProject(id);assert.equal(project.revision,revision)
    return (await saveCreativeProject(id,{...project,production:{...project.production,sources:project.production.sources.map(s=>s.id===sourceId?{...s,transcript:'真实原稿'}:s)}}))
  }})))
  r.start((await p).id,(await p).revision);await tick(r,(await p).id)
  assert.equal((await runFor((await p).id)).status,'waiting');assert.equal((await runFor((await p).id)).revision,(await p).revision+1)
  await tick(r,(await p).id)
  assert.equal((await runFor((await p).id)).status,'review');assert.equal(calls,1)
})

await test('pipeline compose uses the real renderer and resumes the same job', {timeout:60000},async()=>{
  const p=create('documentary')
  const r=runner((await createStageExecutor({...pipelineTools,toolPlan:()=>[],narrative:async()=>narrative,plan:async ctx=>ctx.project})))
  r.start((await p).id,(await p).revision)
  for(let count=0;count<200&&(await runFor((await p).id)).status!=='completed';count++) {
    await tick(r,(await p).id)
    assert.notEqual((await runFor((await p).id)).status,'failed',(await runFor((await p).id)).error??'failed')
    if((await runFor((await p).id)).status==='waiting')await new Promise(resolve=>setTimeout(resolve,100))
  }
  assert.equal((await runFor((await p).id)).status,'completed')
  const project=(await getCreativeProject((await p).id))
  assert.equal(project.renders.length,1);assert.equal(project.renders[0].status,'completed')
  assert.ok((await fs.stat(path.join(directory,project.renders[0].videoUrl!.replace(/^\//,'')))).size>0)
  assert.ok(Math.abs(project.renders[0].duration!-5)<0.1)
})

await test('cancelled review runs remain immutable and cannot be revived by approval',async()=>{
  const p=create('talking_head'),r=runner(async()=>({artifact:narrative}))
  r.start((await p).id,1);await tick(r,(await p).id)
  let current=runFor((await p).id)
  r.cancel((await p).id,(await current).id,(await current).version);current=runFor((await p).id)
  assert.throws(async ()=>r.approve((await p).id,(await current).id,(await current).version),/没有可确认/)
  assert.equal(runFor((await p).id).status,'cancelled')
})

await test('generated video is not treated as proof that planned narration has been produced',async()=>{
  const {approveCreativeProject}=await import('../../src/drama/services/creative-projects.js')
  let p=create('cinematic');p=(await saveCreativeProject((await p).id,{...p,shots:(await p).shots.map(s=>({...s,narration:'必须存在的旁白'}))}));p=(await approveCreativeProject((await p).id,(await p).revision))
  const definition=pipelineDefinitions.find(d=>d.category==='cinematic')!
  await assert.rejects(createStageExecutor()({project:p,definition,stage:definition.stages.find(s=>s.id==='assets')!,artifacts:{},previous:null,retry:false,checkpoint:()=>{}}),/没有可用旁白音轨/)
})
