import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unified-ai-'))
process.env.SQLITE_PATH = path.join(directory, 'test.sqlite')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema, getInsertId } = await import('../src/db/index.js')
const { migrateServiceConfigs, resolveServiceRow } = await import('../src/services/ai-registry.js')
const { getActiveConfig, getConfigById } = await import('../src/services/ai.js')
const { requireToolConfig, saveToolSettings, publicToolSettings } = await import('../src/services/creative-tools/settings.js')
const { default: app } = await import('../src/routes/aiConfigs.js')
const now = new Date().toISOString()
function insert(type: string, provider: string, key = 'secret', priority = 0) {
  return getInsertId(db.insert(schema.aiServiceConfigs).values({ serviceType: type, provider, name: type,
    baseUrl: provider === 'openai' ? 'https://api.openai.com' : 'https://api.sync.so', apiKey: key,
    model: JSON.stringify([provider === 'openai' ? 'text-model' : 'sync-3']), priority, isActive: true,
    createdAt: now, updatedAt: now }).run())
}
async function request(url: string, method = 'GET', body?: unknown) {
  const response = await app.request(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return { status: response.status, body: await response.json() }
}
after(async () => { await fs.rm(directory, { recursive: true, force: true }) })

test('migration preserves legacy secrets and speech settings exactly once', async () => {
  insert('text', 'openai', 'shared-speech-secret')
  db.insert(schema.appSettings).values({ key: 'creative_tool_sync', value: JSON.stringify({ enabled: true, apiKey: 'old-sync-secret', model: 'sync-3' }), updatedAt: now }).run()
  const projectId = getInsertId(db.insert(schema.dramas).values({ title: 'Legacy task', createdAt: now, updatedAt: now }).run())
  const data = { shotId: 'speaker', model: 'sync-3' }
  const jobId = getInsertId(db.insert(schema.creativeToolJobs).values({ projectId, kind: 'lipsync', revision: 1,
    fingerprint: 'legacy-fingerprint', input: JSON.stringify(data), remoteId: 'existing-task', createdAt: now, updatedAt: now }).run())
  migrateServiceConfigs()
  const migratedJob = db.select().from(schema.creativeToolJobs).where(eq(schema.creativeToolJobs.id, jobId)).get()!
  const migratedInput = { ...data, configId: resolveServiceRow('lipsync')!.id }
  assert.deepEqual(JSON.parse(migratedJob.input), migratedInput)
  assert.equal(migratedJob.remoteId, 'existing-task')
  assert.equal(migratedJob.fingerprint, createHash('sha256').update(JSON.stringify({ kind: 'lipsync', data: migratedInput })).digest('hex'))
  assert.equal(resolveServiceRow('lipsync')!.apiKey, 'old-sync-secret')
  assert.equal(resolveServiceRow('lipsync')!.model, '["sync-3"]')
  assert.equal(db.select().from(schema.appSettings).where(eq(schema.appSettings.key, 'creative_tool_sync')).get(), undefined)
  assert.equal((await getActiveConfig('speech'))?.model, 'gpt-4o-mini-tts')
  assert.equal((await getActiveConfig('transcription'))?.model, 'whisper-1')
  assert.equal((await getActiveConfig('speech'))?.apiKey, 'shared-speech-secret')
  const count = db.select().from(schema.aiServiceConfigs).all().length
  migrateServiceConfigs(); migrateServiceConfigs()
  assert.equal(db.select().from(schema.aiServiceConfigs).all().length, count)
  db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.serviceType, 'speech')).run()
  migrateServiceConfigs()
  assert.equal(await getActiveConfig('speech'), null)
})

test('both engines share priorities; pinned IDs cannot switch accounts or capabilities', async () => {
  const old = resolveServiceRow('lipsync')!
  const selected = insert('lipsync', 'sync', 'other-account-secret', 9)
  assert.equal((await getActiveConfig('lipsync'))?.id, selected)
  assert.equal(requireToolConfig('sync').id, selected)
  assert.equal(requireToolConfig('sync', old.id).apiKey, 'old-sync-secret')
  assert.equal(await getConfigById(selected, 'image'), null)
  assert.equal((await getConfigById(selected, 'lipsync'))?.apiKey, 'other-account-secret')
  db.update(schema.aiServiceConfigs).set({ isActive: false }).where(eq(schema.aiServiceConfigs.id, old.id)).run()
  assert.throws(() => requireToolConfig('sync', old.id), /配置/)
})

test('compatibility tool API writes only the shared registry', async () => {
  saveToolSettings('tavily', { enabled: true, apiKey: 'tavily-secret' })
  assert.equal((await getActiveConfig('research'))?.apiKey, 'tavily-secret')
  assert.equal((await getActiveConfig('research'))?.model, 'search')
  assert.equal(db.select().from(schema.appSettings).where(eq(schema.appSettings.key, 'creative_tool_tavily')).get(), undefined)
  assert.ok(!JSON.stringify(publicToolSettings()).includes('tavily-secret'))
})

test('CRUD redacts credentials; blank edits preserve and explicit clearing removes secrets', async () => {
  const create = await request('/', 'POST', { service_type: 'rigging', provider: 'meshy', base_url: 'https://api.meshy.ai', model: ['rigging'], api_key: 'meshy-private' })
  assert.equal(create.status, 201)
  assert.ok(!JSON.stringify(create.body).includes('meshy-private'))
  const row = resolveServiceRow('rigging')!
  assert.ok(!JSON.stringify((await request('/')).body).includes('secret'))
  const detail = await request(`/${row.id}`)
  assert.equal(detail.body.data.has_api_key, true)
  assert.equal(detail.body.data.api_key, undefined)
  assert.equal((await request(`/${row.id}`, 'PUT', { name: 'updated', api_key: '' })).status, 200)
  assert.equal(resolveServiceRow('rigging')!.apiKey, 'meshy-private')
  assert.equal((await request(`/${row.id}`, 'PUT', { clear_key: true, is_active: false })).status, 200)
  assert.equal((await request(`/${row.id}`)).body.data.has_api_key, false)
})

test('dedicated adapters reject unsupported models, addresses and type changes', async () => {
  assert.equal((await request('/', 'POST', { service_type: 'transcription', provider: 'openai', model: ['text-model'] })).status, 400)
  assert.equal((await request('/', 'POST', { service_type: 'lipsync', provider: 'sync', base_url: 'https://other.example', model: ['sync-3'] })).status, 400)
  const id = resolveServiceRow('lipsync')!.id
  assert.equal((await request(`/${id}`, 'PUT', { service_type: 'text', provider: 'openai' })).status, 400)
})

test('probes resolve saved keys server-side and reject forwarding them to another endpoint', async () => {
  const row = resolveServiceRow('text')!
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    calls++
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer shared-speech-secret')
    return Response.json({ data: [] })
  }
  try {
    const body = { config_id: row.id, service_type: 'text', provider: 'openai', base_url: row.baseUrl, model: ['text-model'] }
    assert.equal((await request('/test', 'POST', body)).body.data.ok, true)
    assert.equal((await request('/test', 'POST', { ...body, base_url: 'https://other.example' })).status, 400)
    assert.equal((await request(`/${row.id}`, 'PUT', { base_url: 'https://other.example', api_key: '' })).status, 400)
    assert.equal(calls, 1)
  } finally { globalThis.fetch = original }
})

test('shared text factory applies the selected model, credentials and temperature to real SDK requests', async () => {
  const { getTextModel } = await import('../src/services/ai-text.js')
  const row = resolveServiceRow('text')!
  db.update(schema.aiServiceConfigs).set({ baseUrl: 'https://gateway.example', settings: '{"temperature":0.6}' }).where(eq(schema.aiServiceConfigs.id, row.id)).run()
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (url, init) => {
    calls++
    assert.equal(String(url), 'https://gateway.example/v1/chat/completions')
    const body = JSON.parse(init!.body as string)
    assert.equal(body.model, calls === 1 ? 'text-model' : 'explicit-model')
    assert.equal(body.temperature, 0.6)
    assert.equal(body.enable_thinking, false)
    assert.equal(body.max_tokens, 16384)
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer shared-speech-secret')
    return Response.json({ id: 'test', created: 1, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
  }
  try {
    for (const options of [{}, { configId: row.id, model: 'explicit-model' }]) {
      const model = await getTextModel(options)
      const result = await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
      assert.deepEqual(result.content, [{ type: 'text', text: 'ok' }])
    }
    assert.equal(calls, 2)
  } finally { globalThis.fetch = original }
})

test('service options round-trip with temperature while credential fields remain forbidden',async()=>{
 const row=resolveServiceRow('text')!
 const options={workflow_json:{'1':{class_type:'SaveImage',inputs:{}}},prompt_node:'2'}
 assert.equal((await request(`/${row.id}`,'PUT',{service_options:options,temperature:0.4,api_key:''})).status,200)
 const selected=await getActiveConfig('text');assert.deepEqual(selected?.serviceOptions,options);assert.equal(selected?.temperature,0.4)
 const detail=await request(`/${row.id}`);assert.deepEqual(detail.body.data.service_options,options);assert.equal(detail.body.data.api_key,undefined)
 assert.equal((await request(`/${row.id}`,'PUT',{service_options:{client_secret:'not-allowed'}})).status,400)
})
